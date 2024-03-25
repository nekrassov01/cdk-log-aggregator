import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface DistributionProps {
  serviceName: string;
  hostedZoneName: string;
  cfDomainName: string;
  logBucket: cdk.aws_s3.Bucket;
}

export class Distribution extends Construct {
  readonly distributionName: string;

  constructor(scope: Construct, id: string, props: DistributionProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    // Hosted zone
    const hostedZone = cdk.aws_route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: props.hostedZoneName,
    });

    // Create certificate for CloudFront
    const certificate = new cdk.aws_certificatemanager.DnsValidatedCertificate(this, "Certificate", {
      certificateName: `${props.serviceName}-certificate`,
      domainName: props.cfDomainName,
      subjectAlternativeNames: [props.cfDomainName, "*." + props.cfDomainName],
      region: "us-east-1",
      validation: cdk.aws_certificatemanager.CertificateValidation.fromDns(),
      cleanupRoute53Records: false, // for safety
      hostedZone: hostedZone,
    });

    // Create hosting bucket
    const hostingBucket = new cdk.aws_s3.Bucket(this, "HostingBucket", {
      bucketName: `${props.serviceName}-website`,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [cdk.aws_s3.HttpMethods.GET, cdk.aws_s3.HttpMethods.HEAD],
          allowedOrigins: [`https://${props.cfDomainName}`, `https://*.${props.cfDomainName}`],
          exposedHeaders: [],
          maxAge: 3000,
        },
      ],
    });

    // Create OriginAccessControl
    const oac = new cdk.aws_cloudfront.CfnOriginAccessControl(this, "OAC", {
      originAccessControlConfig: {
        name: hostingBucket.bucketDomainName,
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
        description: hostingBucket.bucketDomainName,
      },
    });

    // Create CloudFront distribution
    this.distributionName = `${props.serviceName}-distribution`;
    const distribution = new cdk.aws_cloudfront.Distribution(this, "Distribution", {
      enabled: true,
      comment: this.distributionName,
      domainNames: [props.cfDomainName],
      defaultRootObject: "index.html",
      priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cdk.aws_cloudfront.HttpVersion.HTTP2,
      certificate: certificate,
      minimumProtocolVersion: cdk.aws_cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableIpv6: false,
      enableLogging: true,
      logBucket: props.logBucket,
      logFilePrefix: this.distributionName,
      logIncludesCookies: true,
      defaultBehavior: {
        origin: new cdk.aws_cloudfront_origins.S3Origin(hostingBucket, {
          originPath: "/",
          connectionAttempts: 3,
          connectionTimeout: cdk.Duration.seconds(10),
        }),
        compress: true,
        allowedMethods: cdk.aws_cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cdk.aws_cloudfront.CachedMethods.CACHE_GET_HEAD,
        viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        //cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        cachePolicy: cdk.aws_cloudfront.CachePolicy.CACHING_DISABLED, // cache disabling for test
        originRequestPolicy: cdk.aws_cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy:
          cdk.aws_cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT_AND_SECURITY_HEADERS,
        smoothStreaming: false,
      },
    });

    // Override L1 properties
    const cfnDistribution = distribution.node.defaultChild as cdk.aws_cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride("DistributionConfig.Origins.0.Id", "hosting-bucket");
    cfnDistribution.addPropertyOverride("DistributionConfig.DefaultCacheBehavior.TargetOriginId", "hosting-bucket");
    cfnDistribution.addPropertyOverride("DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity", "");
    cfnDistribution.addPropertyOverride("DistributionConfig.Origins.0.OriginAccessControlId", oac.attrId);

    // Create policy for hosting bucket
    const hostingBucketPolicyStatement = new cdk.aws_iam.PolicyStatement({
      principals: [new cdk.aws_iam.ServicePrincipal("cloudfront.amazonaws.com")],
      effect: cdk.aws_iam.Effect.ALLOW,
      resources: [`${hostingBucket.bucketArn}/*`],
      actions: ["s3:GetObject"],
    });
    hostingBucketPolicyStatement.addCondition("StringEquals", {
      "AWS:SourceAccount": stack.account,
    });

    // Add bucket policy to hosting bucket
    hostingBucket.addToResourcePolicy(hostingBucketPolicyStatement);

    // Deploy items for website hosting bucket
    new cdk.aws_s3_deployment.BucketDeployment(this, "HostingBucketDeployment", {
      sources: [cdk.aws_s3_deployment.Source.asset("src/s3/hosting/")],
      destinationBucket: hostingBucket,
      distribution: distribution,
      distributionPaths: ["/*"],
      prune: true,
      logRetention: cdk.aws_logs.RetentionDays.THREE_DAYS,
    });

    // Alias record for CloudFront
    const distributionARecord = new cdk.aws_route53.ARecord(this, "DistributionARecord", {
      recordName: props.cfDomainName,
      target: cdk.aws_route53.RecordTarget.fromAlias(new cdk.aws_route53_targets.CloudFrontTarget(distribution)),
      zone: hostedZone,
    });
    distributionARecord.node.addDependency(distribution);
  }
}
