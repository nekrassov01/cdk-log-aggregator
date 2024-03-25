#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import "source-map-support/register";
import { LogAggregatorStack } from "../lib/stack";

const app = new App();

// Get context
const owner = app.node.tryGetContext("owner");
const serviceName = app.node.tryGetContext("serviceName");
const hostedZoneName = app.node.tryGetContext("hostedZoneName");
const albDomainName = `${serviceName}-alb.${hostedZoneName}`;
const nlbDomainName = `${serviceName}-nlb.${hostedZoneName}`;
const cfDomainName = `${serviceName}-cf.${hostedZoneName}`;

// Deploy stack
new LogAggregatorStack(app, "LogAggregatorStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-northeast-1",
  },
  terminationProtection: false,
  serviceName: serviceName,
  cidr: "10.0.0.0/16",
  azPrimary: "ap-northeast-1a",
  azSecondary: "ap-northeast-1c",
  hostedZoneName: hostedZoneName,
  albDomainName: albDomainName,
  nlbDomainName: nlbDomainName,
  cfDomainName: cfDomainName,
});

// Tagging all resources
Tags.of(app).add("Owner", owner);
