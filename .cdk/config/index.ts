import { Environment } from "aws-cdk-lib";
import { EnvConfig } from "./environments";

interface IEnvironmentConfig {
  readonly env: Environment;
}

interface IMapEnvironments {
  [key: string]: IEnvironmentConfig;
}

const MappingEnvironments: IMapEnvironments = {
  "env-ap-southeast-2": EnvConfig,
};

const GetEnvironmentConfig = (environmentName: string): IEnvironmentConfig => {
  return MappingEnvironments[environmentName];
};

export { IEnvironmentConfig, GetEnvironmentConfig };
