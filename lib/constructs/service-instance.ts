import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface InstanceProps {
  serviceName: string;
  vpc: cdk.aws_ec2.Vpc;
  publicSubnets: cdk.aws_ec2.SubnetSelection;
  logBucket: cdk.aws_s3.Bucket;
  eicSecurityGroup: cdk.aws_ec2.SecurityGroup;
}

export class Instance extends Construct {
  readonly instanceName: string;

  constructor(scope: Construct, id: string, props: InstanceProps) {
    super(scope, id);

    const prefix = "web";
    this.instanceName = `${props.serviceName}-${prefix}-instance`;
    const userData = cdk.aws_ec2.UserData.forLinux({ shebang: "#!/bin/bash" });
    userData.addCommands(
      "# setup httpd",
      "sudo yum update -y",
      "sudo yum install -y httpd",
      "sudo systemctl start httpd",
      "sudo systemctl enable httpd",
      "sudo touch /var/www/html/index.html",
      'echo "Hello from httpd" | sudo tee -a /var/www/html/index.html',
      "",
      "# setup td-agent",
      "curl -L https://toolbelt.treasuredata.com/sh/install-amazon2-td-agent3.sh | sh",
      'sudo sed -i -e "s|^User=td-agent|User=root|g" /usr/lib/systemd/system/td-agent.service',
      'sudo sed -i -e "s|^Group=td-agent|Group=root|g" /usr/lib/systemd/system/td-agent.service',
      "sudo cp /etc/td-agent/td-agent.conf /etc/td-agent/td-agent.conf.bk",
      "",
      `CONFIG=$(
  cat <<EOF
<source>
  @type tail
  path /var/log/httpd/access_log
  pos_file /var/log/td-agent/access_log.pos
  tag access_log
  <parse>
    @type none
  </parse>
  </source>

<match access_log>
  @type s3
  s3_bucket ${props.logBucket.bucketName}
  s3_region ap-northeast-1
  path ${this.instanceName}/
  time_slice_format %Y/%m/%d/%H-%M-%S
  <format>
    @type single_value
  </format>
  <buffer>
  @type file
    path /var/log/td-agent/s3
    timekey 5m
    timekey_wait 5m
    chunk_limit_size 256m
  </buffer>
</match>
EOF
)`,
      "",
      'echo "$CONFIG" | sudo tee /etc/td-agent/td-agent.conf >/dev/null',
      "sudo systemctl restart td-agent.service"
    );

    // Role
    const ec2Role = new cdk.aws_iam.Role(this, "InstanceRole", {
      roleName: `${props.serviceName}-${prefix}-instance-role`,
      assumedBy: new cdk.aws_iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromManagedPolicyArn(this, "S3Access", "arn:aws:iam::aws:policy/AmazonS3FullAccess"),
      ],
    });
    new cdk.aws_iam.CfnInstanceProfile(this, "InstanceProfile", {
      instanceProfileName: `${props.serviceName}-${prefix}-instance-profile`,
      roles: [ec2Role.roleName],
    });

    // SecurityGroup
    const ec2SecurityGroupName = `${props.serviceName}-${prefix}-instance-security-group`;
    const ec2SecurityGroup = new cdk.aws_ec2.SecurityGroup(this, "InstanceSecurityGroup", {
      securityGroupName: ec2SecurityGroupName,
      description: ec2SecurityGroupName,
      vpc: props.vpc,
      allowAllOutbound: true,
    });
    cdk.Tags.of(ec2SecurityGroup).add("Name", ec2SecurityGroupName);
    ec2SecurityGroup.connections.allowFromAnyIpv4(
      cdk.aws_ec2.Port.tcp(80),
      "Allow access to EC2 instance from anyone on port 80"
    );
    ec2SecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.securityGroupId(props.eicSecurityGroup.securityGroupId),
      cdk.aws_ec2.Port.tcp(22),
      "Allow access to EC2 instance from EC2 Instance Connect on port 22",
      false
    );

    // Instance
    const instance = new cdk.aws_ec2.Instance(this, "Instance", {
      instanceName: `${props.serviceName}-${prefix}-instance`,
      instanceType: cdk.aws_ec2.InstanceType.of(cdk.aws_ec2.InstanceClass.T3, cdk.aws_ec2.InstanceSize.MICRO),
      machineImage: cdk.aws_ec2.MachineImage.latestAmazonLinux2({
        cpuType: cdk.aws_ec2.AmazonLinuxCpuType.X86_64,
      }),
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: cdk.aws_ec2.BlockDeviceVolume.ebs(8, {
            volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      vpc: props.vpc,
      vpcSubnets: props.publicSubnets,
      securityGroup: ec2SecurityGroup,
      role: ec2Role,
      requireImdsv2: true,
      userData: userData!,
      associatePublicIpAddress: true,
    });
    const cfnInstance = instance.node.defaultChild as cdk.aws_ec2.CfnInstance;
    cfnInstance.addPropertyOverride("CreditSpecification.CPUCredits", "standard");
  }
}
