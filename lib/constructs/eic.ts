import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface InstanceConnectEndpointProps {
  serviceName: string;
  vpc: cdk.aws_ec2.IVpc;
}

export class InstanceConnectEndpoint extends Construct {
  readonly securityGroup: cdk.aws_ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: InstanceConnectEndpointProps) {
    super(scope, id);

    // EC2 Instance Connect endpoint SecurityGroup
    const eicSecurityGroupName = `${props.serviceName}-eic-security-group`;
    this.securityGroup = new cdk.aws_ec2.SecurityGroup(this, "InstanceConnectSecurityGroup", {
      securityGroupName: eicSecurityGroupName,
      description: eicSecurityGroupName,
      vpc: props.vpc,
      allowAllOutbound: true,
    });
    cdk.Tags.of(this.securityGroup).add("Name", eicSecurityGroupName);

    // EC2 Instance Connect endpoint
    new cdk.aws_ec2.CfnInstanceConnectEndpoint(this, "InstanceConnectEndpoint", {
      subnetId: props.vpc.publicSubnets[0].subnetId,
      securityGroupIds: [this.securityGroup.securityGroupId],
      preserveClientIp: true,
      clientToken: `${props.serviceName}-eic-client-token`,
    });
  }
}
