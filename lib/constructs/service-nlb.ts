import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface NLBProps {
  serviceName: string;
  hostedZoneName: string;
  nlbDomainName: string;
  vpc: cdk.aws_ec2.Vpc;
  publicSubnets: cdk.aws_ec2.SubnetSelection;
  privateSubnets: cdk.aws_ec2.SubnetSelection;
  logBucket: cdk.aws_s3.Bucket;
  eicSecurityGroup: cdk.aws_ec2.SecurityGroup;
}

export class NLB extends Construct {
  readonly nlb: cdk.aws_elasticloadbalancingv2.NetworkLoadBalancer;
  readonly instance: cdk.aws_ec2.Instance;

  constructor(scope: Construct, id: string, props: NLBProps) {
    super(scope, id);

    const prefix = "nlb";
    const userData = cdk.aws_ec2.UserData.forLinux({ shebang: "#!/bin/bash" });
    userData.addCommands(
      "# setup httpd",
      "sudo yum update -y",
      "sudo yum install -y httpd",
      "sudo systemctl start httpd",
      "sudo systemctl enable httpd",
      "sudo touch /var/www/html/index.html",
      'echo "Hello from httpd" | sudo tee -a /var/www/html/index.html'
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
    const ec2SecurityGroup = new cdk.aws_ec2.SecurityGroup(this, `InstanceSecurityGroup`, {
      securityGroupName: ec2SecurityGroupName,
      description: ec2SecurityGroupName,
      vpc: props.vpc,
      allowAllOutbound: true,
    });
    cdk.Tags.of(ec2SecurityGroup).add("Name", ec2SecurityGroupName);
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
      vpcSubnets: props.privateSubnets,
      securityGroup: ec2SecurityGroup,
      role: ec2Role,
      requireImdsv2: true,
      userData: userData!,
    });
    const cfnInstance = instance.node.defaultChild as cdk.aws_ec2.CfnInstance;
    cfnInstance.addPropertyOverride("CreditSpecification.CPUCredits", "standard");

    // Hosted zone
    const hostedZone = cdk.aws_route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: props.hostedZoneName,
    });

    // Certificate
    const certificate = new cdk.aws_certificatemanager.Certificate(this, "Certificate", {
      certificateName: `${props.serviceName}-certificate`,
      domainName: props.nlbDomainName,
      subjectAlternativeNames: [props.nlbDomainName, "*." + props.nlbDomainName],
      validation: cdk.aws_certificatemanager.CertificateValidation.fromDns(hostedZone),
    });

    // NLB security group
    const nlbSecurityGroupName = `${props.serviceName}-${prefix}-security-group`;
    const nlbSecurityGroup = new cdk.aws_ec2.SecurityGroup(this, "SecurityGroup", {
      securityGroupName: nlbSecurityGroupName,
      description: nlbSecurityGroupName,
      vpc: props.vpc,
      allowAllOutbound: false,
    });
    cdk.Tags.of(nlbSecurityGroup).add("Name", nlbSecurityGroupName);

    // NLB
    const nlbName = `${props.serviceName}-nlb`;
    this.nlb = new cdk.aws_elasticloadbalancingv2.NetworkLoadBalancer(this, "NLB", {
      loadBalancerName: nlbName,
      vpc: props.vpc,
      vpcSubnets: props.publicSubnets,
      internetFacing: true,
      securityGroups: [nlbSecurityGroup],
    });
    this.nlb.logAccessLogs(props.logBucket, nlbName);
    nlbSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4("0.0.0.0/0"),
      cdk.aws_ec2.Port.tcp(443),
      "Allow access to NLB from anyone on port 443",
      false
    );
    nlbSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4("0.0.0.0/0"),
      cdk.aws_ec2.Port.tcp(80),
      "Allow access to NLB from anyone on port 80",
      false
    );
    instance.connections.allowFrom(
      nlbSecurityGroup,
      cdk.aws_ec2.Port.tcp(80),
      "Allow access to EC2 instance from ALB on port 80"
    );

    // NLB HTTPS listener
    this.nlb.addListener("ListenerTLS", {
      protocol: cdk.aws_elasticloadbalancingv2.Protocol.TLS,
      port: 443,
      sslPolicy: cdk.aws_elasticloadbalancingv2.SslPolicy.TLS13_13,
      certificates: [
        {
          certificateArn: certificate.certificateArn,
        },
      ],
      defaultTargetGroups: [
        new cdk.aws_elasticloadbalancingv2.NetworkTargetGroup(this, "NLBTargetGroup", {
          targetGroupName: `${props.serviceName}-nlb-tg`,
          targetType: cdk.aws_elasticloadbalancingv2.TargetType.INSTANCE,
          targets: [new cdk.aws_elasticloadbalancingv2_targets.InstanceTarget(instance)],
          protocol: cdk.aws_elasticloadbalancingv2.Protocol.TCP,
          port: 80,
          healthCheck: {
            protocol: cdk.aws_elasticloadbalancingv2.Protocol.TCP,
            port: "traffic-port",
          },
          vpc: props.vpc,
        }),
      ],
    });

    // Alias record for NLB
    const nlbARecord = new cdk.aws_route53.ARecord(this, "DistributionARecord", {
      recordName: props.nlbDomainName,
      target: cdk.aws_route53.RecordTarget.fromAlias(new cdk.aws_route53_targets.LoadBalancerTarget(this.nlb)),
      zone: hostedZone,
    });
    nlbARecord.node.addDependency(this.nlb);
  }
}
