import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface ALBProps {
  serviceName: string;
  hostedZoneName: string;
  albDomainName: string;
  vpc: cdk.aws_ec2.Vpc;
  publicSubnets: cdk.aws_ec2.SubnetSelection;
  privateSubnets: cdk.aws_ec2.SubnetSelection;
  logBucket: cdk.aws_s3.Bucket;
  eicSecurityGroup: cdk.aws_ec2.SecurityGroup;
}

export class ALB extends Construct {
  readonly alb: cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: ALBProps) {
    super(scope, id);

    const prefix = "alb";
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
    const ec2SecurityGroup = new cdk.aws_ec2.SecurityGroup(this, "InstanceSecurityGroup", {
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
      domainName: props.albDomainName,
      subjectAlternativeNames: [props.albDomainName, "*." + props.albDomainName],
      validation: cdk.aws_certificatemanager.CertificateValidation.fromDns(hostedZone),
    });

    // ALB security group
    const albSecurityGroupName = `${props.serviceName}-alb-security-group`;
    const albSecurityGroup = new cdk.aws_ec2.SecurityGroup(this, "ALBSecurityGroup", {
      securityGroupName: albSecurityGroupName,
      description: albSecurityGroupName,
      vpc: props.vpc,
      allowAllOutbound: false,
    });
    cdk.Tags.of(albSecurityGroup).add("Name", albSecurityGroupName);

    // ALB
    const albName = `${props.serviceName}-alb`;
    this.alb = new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(this, "ALB", {
      loadBalancerName: albName,
      vpc: props.vpc,
      vpcSubnets: props.publicSubnets,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });
    this.alb.logAccessLogs(props.logBucket, albName);
    albSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4("0.0.0.0/0"),
      cdk.aws_ec2.Port.tcp(443),
      "Allow access to ALB from anyone on port 443",
      false
    );
    albSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4("0.0.0.0/0"),
      cdk.aws_ec2.Port.tcp(80),
      "Allow access to ALB from anyone on port 80",
      false
    );
    instance.connections.allowFrom(
      albSecurityGroup,
      cdk.aws_ec2.Port.tcp(80),
      "Allow access to EC2 instance from ALB on port 80"
    );

    // ALB HTTPS listener
    this.alb.addListener("ListenerHTTPS", {
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      sslPolicy: cdk.aws_elasticloadbalancingv2.SslPolicy.TLS13_13,
      certificates: [
        {
          certificateArn: certificate.certificateArn,
        },
      ],
      defaultTargetGroups: [
        new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(this, "ALBTargetGroup", {
          targetGroupName: `${props.serviceName}-alb-tg`,
          targetType: cdk.aws_elasticloadbalancingv2.TargetType.INSTANCE,
          targets: [new cdk.aws_elasticloadbalancingv2_targets.InstanceTarget(instance)],
          protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
          port: 80,
          healthCheck: {
            protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
            port: "traffic-port",
          },
          vpc: props.vpc,
        }),
      ],
    });

    // ALB HTTP listener
    this.alb.addListener("ListenerHTTP", {
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
      defaultAction: cdk.aws_elasticloadbalancingv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        host: "#{host}",
        path: "/#{path}",
        query: "#{query}",
        permanent: true,
      }),
    });

    // Alias record for ALB
    const albARecord = new cdk.aws_route53.ARecord(this, "DistributionARecord", {
      recordName: props.albDomainName,
      target: cdk.aws_route53.RecordTarget.fromAlias(new cdk.aws_route53_targets.LoadBalancerTarget(this.alb)),
      zone: hostedZone,
    });
    albARecord.node.addDependency(this.alb);
  }
}
