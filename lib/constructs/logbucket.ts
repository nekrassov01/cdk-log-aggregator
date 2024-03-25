import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface LogBucketProps {
  serviceName: string;
}

export class LogBucket extends Construct {
  readonly logBucket: cdk.aws_s3.Bucket;

  constructor(scope: Construct, id: string, props: LogBucketProps) {
    super(scope, id);

    // Bucket for aggregating access logs
    this.logBucket = new cdk.aws_s3.Bucket(this, "LogBucket", {
      bucketName: `${props.serviceName}-accesslogs`,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      objectOwnership: cdk.aws_s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });
  }
}
