import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Network } from "./constructs/network";
import { InstanceConnectEndpoint } from "./constructs/eic";
import { ALB } from "./constructs/service-alb";
import { NLB } from "./constructs/service-nlb";
import { Instance } from "./constructs/service-instance";
import { Distribution } from "./constructs/service-distribution";
import { Handler } from "./constructs/handler";
import { Stream } from "./constructs/stream";
import { LogBucket } from "./constructs/logbucket";

export interface LogAggregatorStackProps extends StackProps {
  serviceName: string;
  cidr: string;
  azPrimary: string;
  azSecondary: string;
  hostedZoneName: string;
  albDomainName: string;
  nlbDomainName: string;
  cfDomainName: string;
}

export class LogAggregatorStack extends Stack {
  constructor(scope: Construct, id: string, props: LogAggregatorStackProps) {
    super(scope, id, props);

    const logBucket = new LogBucket(this, "LogBucket", {
      serviceName: props.serviceName,
    });

    const network = new Network(this, "Network", {
      cidr: props.cidr,
      azPrimary: props.azPrimary,
      azSecondary: props.azSecondary,
    });

    const eic = new InstanceConnectEndpoint(this, "InstanceConnectEndpoint", {
      serviceName: props.serviceName,
      vpc: network.vpc,
    });

    const alb = new ALB(this, "ALB", {
      serviceName: props.serviceName,
      hostedZoneName: props.hostedZoneName,
      albDomainName: props.albDomainName,
      vpc: network.vpc,
      publicSubnets: network.publicSubnets,
      privateSubnets: network.privateSubnets,
      logBucket: logBucket.logBucket,
      eicSecurityGroup: eic.securityGroup,
    });

    const nlb = new NLB(this, "NLB", {
      serviceName: props.serviceName,
      hostedZoneName: props.hostedZoneName,
      nlbDomainName: props.nlbDomainName,
      vpc: network.vpc,
      publicSubnets: network.publicSubnets,
      privateSubnets: network.privateSubnets,
      logBucket: logBucket.logBucket,
      eicSecurityGroup: eic.securityGroup,
    });

    const instance = new Instance(this, "Instance", {
      serviceName: props.serviceName,
      vpc: network.vpc,
      publicSubnets: network.publicSubnets,
      logBucket: logBucket.logBucket,
      eicSecurityGroup: eic.securityGroup,
    });

    const distribution = new Distribution(this, "Distribution", {
      serviceName: props.serviceName,
      hostedZoneName: props.hostedZoneName,
      cfDomainName: props.cfDomainName,
      logBucket: logBucket.logBucket,
    });

    const stream = new Stream(this, "Stream", {
      serviceName: props.serviceName,
    });

    new Handler(this, "Handler", {
      serviceName: props.serviceName,
      logBucket: logBucket.logBucket,
      deliveryStream: stream.deliveryStream,
      alb: alb.alb,
      nlb: nlb.nlb,
      instanceName: instance.instanceName,
      distributionName: distribution.distributionName,
    });
  }
}
