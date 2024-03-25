import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface StreamProps {
  serviceName: string;
}

export class Stream extends Construct {
  readonly deliveryStream: cdk.aws_kinesisfirehose.CfnDeliveryStream;

  constructor(scope: Construct, id: string, props: StreamProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    // Create S3 bucket for transformed logs
    const dstBucket = new cdk.aws_s3.Bucket(this, "DestinationBucket", {
      bucketName: `${props.serviceName}-destination`,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      objectOwnership: cdk.aws_s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });

    //// Create sqs queue for S3 event notification
    //const queue = new cdk.aws_sqs.Queue(this, "Queue", {
    //  queueName: `${props.serviceName}-destination-queue`,
    //  encryption: cdk.aws_sqs.QueueEncryption.SQS_MANAGED,
    //  enforceSSL: true,
    //  removalPolicy: cdk.RemovalPolicy.DESTROY,
    //  retentionPeriod: cdk.Duration.days(7),
    //  visibilityTimeout: cdk.Duration.minutes(5),
    //  receiveMessageWaitTime: cdk.Duration.seconds(10),
    //  deadLetterQueue: {
    //    maxReceiveCount: 1,
    //    queue: new cdk.aws_sqs.Queue(this, "QueueDLQ", {
    //      queueName: `${props.serviceName}-destination-queue-dlq`,
    //      encryption: cdk.aws_sqs.QueueEncryption.SQS_MANAGED,
    //      enforceSSL: true,
    //      removalPolicy: cdk.RemovalPolicy.DESTROY,
    //      retentionPeriod: cdk.Duration.days(7),
    //      visibilityTimeout: cdk.Duration.minutes(5),
    //    }),
    //  },
    //});

    //// Set sqs queue alias to S3 event
    //dstBucket.addEventNotification(
    //  cdk.aws_s3.EventType.OBJECT_CREATED_PUT,
    //  new cdk.aws_s3_notifications.SqsDestination(queue)
    //);

    // Create role for firehose stream
    const firehoseRole = new cdk.aws_iam.Role(this, "FirehoseRole", {
      roleName: `${props.serviceName}-firehose-role`,
      assumedBy: new cdk.aws_iam.ServicePrincipal("firehose.amazonaws.com"),
      inlinePolicies: {
        ["FirehoseRolePolicy"]: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: [
                "s3:AbortMultipartUpload",
                "s3:GetBucketLocation",
                "s3:GetObject",
                "s3:ListBucket",
                "s3:ListBucketMultipartUploads",
                "s3:PutObject",
              ],
              resources: [dstBucket.bucketArn, `${dstBucket.bucketArn}/*`],
            }),
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ["logs:PutLogEvents"],
              resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/kinesisfirehose/*`],
            }),
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // Create log group and stream for firehose logs
    const firehoseLogGroup = new cdk.aws_logs.LogGroup(this, "FirehoseLogGroup", {
      logGroupName: `/aws/kinesisfirehose/${props.serviceName}-firehose`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: cdk.aws_logs.RetentionDays.THREE_DAYS,
    });
    const firehoseLogStream = new cdk.aws_logs.LogStream(this, "FirehoseLogStream", {
      logGroup: firehoseLogGroup,
      logStreamName: "logs",
    });

    // Create firehose delivery stream
    this.deliveryStream = new cdk.aws_kinesisfirehose.CfnDeliveryStream(this, "Firehose", {
      deliveryStreamName: `${props.serviceName}-firehose`,
      deliveryStreamType: "DirectPut",
      extendedS3DestinationConfiguration: {
        bucketArn: dstBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: firehoseLogStream.logStreamName,
        },
        compressionFormat: "GZIP",
        prefix: "!{partitionKeyFromQuery:resource_type}/!{timestamp:yyyy}/!{timestamp:MM}/!{timestamp:dd}/",
        errorOutputPrefix: "errors/!{firehose:error-output-type}/!{timestamp:yyyy}/!{timestamp:MM}/!{timestamp:dd}/",
        bufferingHints: {
          sizeInMBs: 128,
          intervalInSeconds: 300,
        },
        dynamicPartitioningConfiguration: {
          enabled: true,
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: "RecordDeAggregation",
              parameters: [
                {
                  parameterName: "SubRecordType",
                  parameterValue: "JSON",
                },
              ],
            },
            {
              type: "MetadataExtraction",
              parameters: [
                {
                  parameterName: "MetadataExtractionQuery",
                  parameterValue: "{resource_type: .resource_type}",
                },
                {
                  parameterName: "JsonParsingEngine",
                  parameterValue: "JQ-1.6",
                },
              ],
            },
            {
              type: "AppendDelimiterToRecord",
              parameters: [],
            },
          ],
        },
      },
    });
  }
}
