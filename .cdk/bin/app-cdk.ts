#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { EcsDeployStack } from "../lib/ecs-deploy-stack";
import { toCamel, capitalizeFirstLetter } from "../helpers/string";
import environmentConfig from "../config";

const stage = process.env.STAGE as string;
const appName = capitalizeFirstLetter(toCamel(environmentConfig.name));
const appRevision = process.env.STAGE === "preview" ? process.env.APP_REVISION : "";
const name = `${appName}${capitalizeFirstLetter(stage)}${appRevision}`;
const stackName = toCamel(`Ecs-App-${name}-Stack`);

const stageConfig = environmentConfig.stages[stage];

const app = new cdk.App();

new EcsDeployStack(app, `EcsDeployStack-${stage}`, {
  env: {
    account: stageConfig.aws.account,
    region: stageConfig.aws.region,
  },
  stage,
  stackName,
  appName,
  clusterArn: stageConfig.ecs.cluster_arn,
  clusterSecurityGroupId: stageConfig.ecs.clusterSecurityGroupId,
  route53: {
    ...stageConfig.route53,
    hostname:
      process.env.STAGE === "preview"
        ? `${stageConfig.route53.hostname}-${appRevision}`
        : stageConfig.route53.hostname,
  },
  secretsManager: stageConfig.secretsManager,
  acm: stageConfig.acm,
  vpc: {
    ...stageConfig.vpc,
    name: stageConfig.vpc?.name || `${stageConfig.aws.account_name}-VPC`,
  },
  container: {
    ...environmentConfig.container,
    image: {
      ...environmentConfig.container.image,
      version: process.env.APP_REVISION,
    },
  },
  task: stageConfig.task,
  loadBalancer: stageConfig.loadBalancer,
  autoscaling: stageConfig.autoscaling,
});

app.synth();
