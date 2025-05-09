'use strict';

const AWS = require('../../../../aws/sdk-v2');
const crypto = require('crypto');
const fs = require('fs');
const _ = require('lodash');
const path = require('path');
const ServerlessError = require('../../../../serverless-error');
const deepSortObjectByKey = require('../../../../utils/deep-sort-object-by-key');
const getHashForFilePath = require('../lib/get-hash-for-file-path');
const resolveLambdaTarget = require('../../utils/resolve-lambda-target');
const parseS3URI = require('../../utils/parse-s3-uri');
const { log } = require('@serverless/utils/log');

const defaultCors = {
  allowedOrigins: ['*'],
  allowedHeaders: [
    'Content-Type',
    'X-Amz-Date',
    'Authorization',
    'X-Api-Key',
    'X-Amz-Security-Token',
    'X-Amzn-Trace-Id',
  ],
  allowedMethods: ['*'],
};
const runtimeManagementMap = new Map([
  ['auto', 'Auto'],
  ['onFunctionUpdate', 'FunctionUpdate'],
  ['manual', 'Manual'],
]);

class AwsCompileFunctions {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    const serviceDir = this.serverless.serviceDir || '';
    this.packagePath =
      this.serverless.service.package.path || path.join(serviceDir || '.', '.serverless');

    this.provider = this.serverless.getProvider('aws');

    this.ensureTargetExecutionPermission = _.memoize(this.ensureTargetExecutionPermission);
    if (
      this.serverless.service.provider.name === 'aws' &&
      this.serverless.service.provider.versionFunctions == null
    ) {
      this.serverless.service.provider.versionFunctions = true;
    }

    this.hooks = {
      'initialize': () => {
        if (
          this.serverless.service.provider.lambdaHashingVersion === '20200924' &&
          !this.options['enforce-hash-update']
        ) {
          this.serverless._logDeprecation(
            'LAMBDA_HASHING_VERSION_PROPERTY',
            'Resolution of lambda version hashes with the "20200924" algorithm is deprecated.' +
              ' It is highly recommend to migrate to new default algorithm. Please see' +
              ' the deprecation documentation for more details about the migration process.'
          );
        }

        if (this.serverless.service.provider.lambdaHashingVersion === '20201221') {
          this.serverless._logDeprecation(
            'LAMBDA_HASHING_VERSION_PROPERTY',
            'Setting "20201221" for "provider.lambdaHashingVersion" is no longer effective as' +
              ' new hashing algorithm is now used by default. You can safely remove this' +
              ' property from your configuration.'
          );
        }
      },
      'package:compileFunctions': async () =>
        this.downloadPackageArtifacts().then(this.compileFunctions.bind(this)),
    };
  }

  compileRole(newFunction, role) {
    const compiledFunction = newFunction;
    if (typeof role === 'string') {
      if (role.startsWith('arn:')) {
        // role is a statically defined iam arn
        compiledFunction.Properties.Role = role;
      } else if (role === 'IamRoleLambdaExecution') {
        // role is the default role generated by the framework
        compiledFunction.Properties.Role = { 'Fn::GetAtt': [role, 'Arn'] };
      } else {
        // role is a Logical Role Name
        compiledFunction.Properties.Role = { 'Fn::GetAtt': [role, 'Arn'] };
        compiledFunction.DependsOn = (compiledFunction.DependsOn || []).concat(role);
      }
    } else if ('Fn::GetAtt' in role) {
      // role is an "Fn::GetAtt" object
      compiledFunction.Properties.Role = role;
      compiledFunction.DependsOn = (compiledFunction.DependsOn || []).concat(role['Fn::GetAtt'][0]);
    } else {
      // role is an "Fn::ImportValue" or "Fn::Sub" object
      compiledFunction.Properties.Role = role;
    }
  }

  async downloadPackageArtifact(functionName) {
    const { region } = this.options;
    const S3 = new AWS.S3({ region });

    const functionObject = this.serverless.service.getFunction(functionName);
    if (functionObject.image) return;

    const artifactFilePath =
      _.get(functionObject, 'package.artifact') ||
      _.get(this, 'serverless.service.package.artifact');

    const s3Object = parseS3URI(artifactFilePath);
    if (!s3Object) return;
    log.info(`Downloading ${s3Object.Key} from bucket ${s3Object.Bucket}`);
    await new Promise((resolve, reject) => {
      const tmpDir = this.serverless.utils.getTmpDirPath();
      const filePath = path.join(tmpDir, path.basename(s3Object.Key));

      const readStream = S3.getObject(s3Object).createReadStream();

      const writeStream = fs.createWriteStream(filePath);
      readStream
        .pipe(writeStream)
        .on('error', reject)
        .on('close', () => {
          if (functionObject.package.artifact) {
            functionObject.package.artifact = filePath;
          } else {
            this.serverless.service.package.artifact = filePath;
          }
          return resolve(filePath);
        });
    });
  }

  async addFileToHash(filePath, hash) {
    const lambdaHashingVersion = this.serverless.service.provider.lambdaHashingVersion;
    if (lambdaHashingVersion < 20201221 && !this.options['enforce-hash-update']) {
      await addFileContentsToHashes(filePath, [hash]);
    } else {
      const filePathHash = await getHashForFilePath(filePath);
      hash.write(filePathHash);
    }
  }

  async compileFunction(functionName) {
    const cfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;
    const functionResource = this.cfLambdaFunctionTemplate();
    const functionObject = this.serverless.service.getFunction(functionName);
    functionObject.package = functionObject.package || {};
    const enforceHashUpdate = this.options['enforce-hash-update'];

    if (!functionObject.handler && !functionObject.image) {
      throw new ServerlessError(
        `Either "handler" or "image" property needs to be set on function "${functionName}"`,
        'FUNCTION_NEITHER_HANDLER_NOR_IMAGE_DEFINED_ERROR'
      );
    }
    if (functionObject.handler && functionObject.image) {
      throw new ServerlessError(
        `Either "handler" or "image" property (not both) needs to be set on function "${functionName}".`,
        'FUNCTION_BOTH_HANDLER_AND_IMAGE_DEFINED_ERROR'
      );
    }

    let functionImageUri;
    let functionImageSha;

    if (functionObject.image) {
      ({ functionImageUri, functionImageSha } = await this.provider.resolveImageUriAndSha(
        functionName
      ));
      if (_.isObject(functionObject.image)) {
        const imageConfig = {};
        if (functionObject.image.command) {
          imageConfig.Command = functionObject.image.command;
        }

        if (functionObject.image.entryPoint) {
          imageConfig.EntryPoint = functionObject.image.entryPoint;
        }

        if (functionObject.image.workingDirectory) {
          imageConfig.WorkingDirectory = functionObject.image.workingDirectory;
        }

        if (Object.keys(imageConfig).length) {
          functionResource.Properties.ImageConfig = imageConfig;
        }
      }
    }

    // publish these properties to the platform
    functionObject.memory =
      functionObject.memorySize || this.serverless.service.provider.memorySize || 1024;
    if (!functionObject.timeout) {
      functionObject.timeout = this.serverless.service.provider.timeout || 6;
    }

    let artifactFilePath;

    if (functionObject.handler) {
      const serviceArtifactFileName = this.provider.naming.getServiceArtifactName();
      const functionArtifactFileName = this.provider.naming.getFunctionArtifactName(functionName);

      artifactFilePath =
        functionObject.package.artifact || this.serverless.service.package.artifact;

      if (
        !artifactFilePath ||
        (this.serverless.service.artifact && !functionObject.package.artifact)
      ) {
        let artifactFileName = serviceArtifactFileName;
        if (this.serverless.service.package.individually || functionObject.package.individually) {
          artifactFileName = functionArtifactFileName;
        }

        artifactFilePath = path.join(this.serverless.serviceDir, '.serverless', artifactFileName);
      }

      const runtimeManagement = this.provider.resolveFunctionRuntimeManagement(
        functionObject.runtimeManagement
      );
      if (runtimeManagement.mode !== 'auto') {
        functionResource.Properties.RuntimeManagementConfig = {
          UpdateRuntimeOn: runtimeManagementMap.get(runtimeManagement.mode),
        };

        if (runtimeManagement.mode === 'manual') {
          functionResource.Properties.RuntimeManagementConfig.RuntimeVersionArn =
            runtimeManagement.arn;
        }
      }

      functionObject.runtime = this.provider.getRuntime(functionObject.runtime);
      functionResource.Properties.Handler = functionObject.handler;
      functionResource.Properties.Code.S3Bucket = this.serverless.service.package.deploymentBucket
        ? this.serverless.service.package.deploymentBucket
        : { Ref: 'ServerlessDeploymentBucket' };

      functionResource.Properties.Code.S3Key = `${
        this.serverless.service.package.artifactDirectoryName
      }/${artifactFilePath.split(path.sep).pop()}`;
      functionResource.Properties.Runtime = functionObject.runtime;
    } else {
      functionResource.Properties.Code.ImageUri = functionImageUri;
      functionResource.Properties.PackageType = 'Image';
    }
    functionResource.Properties.FunctionName = functionObject.name;
    functionResource.Properties.MemorySize = functionObject.memory;
    functionResource.Properties.Timeout = functionObject.timeout;

    const functionArchitecture =
      functionObject.architecture || this.serverless.service.provider.architecture;
    if (functionArchitecture) functionResource.Properties.Architectures = [functionArchitecture];

    if (functionObject.description) {
      functionResource.Properties.Description = functionObject.description;
    }

    if (functionObject.condition) {
      functionResource.Condition = functionObject.condition;
    }

    if (functionObject.dependsOn) {
      functionResource.DependsOn = (functionResource.DependsOn || []).concat(
        functionObject.dependsOn
      );
    }

    if (functionObject.tags || this.serverless.service.provider.tags) {
      const tags = Object.assign({}, this.serverless.service.provider.tags, functionObject.tags);
      functionResource.Properties.Tags = [];
      Object.entries(tags).forEach(([Key, Value]) => {
        functionResource.Properties.Tags.push({ Key, Value });
      });
    }

    if (functionObject.ephemeralStorageSize) {
      functionResource.Properties.EphemeralStorage = {
        Size: functionObject.ephemeralStorageSize,
      };
    }

    if (functionObject.onError) {
      const arn = functionObject.onError;

      if (typeof arn === 'string') {
        const iamRoleLambdaExecution = cfTemplate.Resources.IamRoleLambdaExecution;
        functionResource.Properties.DeadLetterConfig = {
          TargetArn: arn,
        };

        // update the PolicyDocument statements (if default policy is used)
        if (iamRoleLambdaExecution) {
          iamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement.push({
            Effect: 'Allow',
            Action: ['sns:Publish'],
            Resource: [arn],
          });
        }
      } else {
        functionResource.Properties.DeadLetterConfig = {
          TargetArn: arn,
        };
      }
    }

    let kmsKeyArn;
    if (this.serverless.service.provider.kmsKeyArn) {
      kmsKeyArn = this.serverless.service.provider.kmsKeyArn;
    }
    if (functionObject.kmsKeyArn) kmsKeyArn = functionObject.kmsKeyArn;

    if (kmsKeyArn) {
      if (typeof kmsKeyArn === 'string') {
        functionResource.Properties.KmsKeyArn = kmsKeyArn;

        // update the PolicyDocument statements (if default policy is used)
        const iamRoleLambdaExecution = cfTemplate.Resources.IamRoleLambdaExecution;
        if (iamRoleLambdaExecution) {
          iamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement = _.unionWith(
            iamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement,
            [
              {
                Effect: 'Allow',
                Action: ['kms:Decrypt'],
                Resource: [kmsKeyArn],
              },
            ],
            _.isEqual
          );
        }
      } else {
        functionResource.Properties.KmsKeyArn = kmsKeyArn;
      }
    }

    const tracing =
      functionObject.tracing ||
      (this.serverless.service.provider.tracing && this.serverless.service.provider.tracing.lambda);

    if (tracing) {
      let mode = tracing;

      if (typeof tracing === 'boolean') {
        mode = 'Active';
      }

      const iamRoleLambdaExecution = cfTemplate.Resources.IamRoleLambdaExecution;

      functionResource.Properties.TracingConfig = {
        Mode: mode,
      };

      const stmt = {
        Effect: 'Allow',
        Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        Resource: ['*'],
      };

      // update the PolicyDocument statements (if default policy is used)
      if (iamRoleLambdaExecution) {
        iamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement = _.unionWith(
          iamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement,
          [stmt],
          _.isEqual
        );
      }
    }

    if (functionObject.environment || this.serverless.service.provider.environment) {
      functionResource.Properties.Environment = {};
      functionResource.Properties.Environment.Variables = Object.assign(
        {},
        this.serverless.service.provider.environment,
        functionObject.environment
      );
    }

    const role = this.provider.getCustomExecutionRole(functionObject);
    this.compileRole(functionResource, role || 'IamRoleLambdaExecution');

    // ensure provider VPC is not used if function VPC explicitly unset
    if (functionObject.vpc !== null && functionObject.vpc !== false) {
      if (!functionObject.vpc) functionObject.vpc = {};
      if (!this.serverless.service.provider.vpc) this.serverless.service.provider.vpc = {};

      functionResource.Properties.VpcConfig = {
        Ipv6AllowedForDualStack:
          functionObject.vpc.ipv6AllowedForDualStack ||
          this.serverless.service.provider.vpc.ipv6AllowedForDualStack,
        SecurityGroupIds:
          functionObject.vpc.securityGroupIds ||
          this.serverless.service.provider.vpc.securityGroupIds,
        SubnetIds: functionObject.vpc.subnetIds || this.serverless.service.provider.vpc.subnetIds,
      };

      if (
        !functionResource.Properties.VpcConfig.SecurityGroupIds ||
        !functionResource.Properties.VpcConfig.SubnetIds
      ) {
        delete functionResource.Properties.VpcConfig;
      }
    }

    const fileSystemConfig = functionObject.fileSystemConfig;

    if (fileSystemConfig) {
      if (!functionResource.Properties.VpcConfig) {
        const errorMessage = [
          `Function "${functionName}": when using fileSystemConfig, `,
          'ensure that function has vpc configured ',
          'on function or provider level',
        ].join('');
        throw new ServerlessError(errorMessage, 'LAMBDA_FILE_SYSTEM_CONFIG_MISSING_VPC');
      }

      const iamRoleLambdaExecution = cfTemplate.Resources.IamRoleLambdaExecution;

      const stmt = {
        Effect: 'Allow',
        Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
        Resource: [fileSystemConfig.arn],
      };

      // update the PolicyDocument statements (if default policy is used)
      if (iamRoleLambdaExecution) {
        iamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement.push(stmt);
      }

      const cfFileSystemConfig = {
        Arn: fileSystemConfig.arn,
        LocalMountPath: fileSystemConfig.localMountPath,
      };

      functionResource.Properties.FileSystemConfigs = [cfFileSystemConfig];
    }

    if (functionObject.reservedConcurrency || functionObject.reservedConcurrency === 0) {
      functionResource.Properties.ReservedConcurrentExecutions = functionObject.reservedConcurrency;
    }

    if (!functionObject.disableLogs) {
      functionResource.DependsOn = [this.provider.naming.getLogGroupLogicalId(functionName)].concat(
        functionResource.DependsOn || []
      );
    }

    if (functionObject.layers) {
      functionResource.Properties.Layers = functionObject.layers;
    } else if (this.serverless.service.provider.layers) {
      // To avoid unwanted side effects ensure to not reference same array instace on each function
      functionResource.Properties.Layers = Array.from(this.serverless.service.provider.layers);
    }

    const functionLogicalId = this.provider.naming.getLambdaLogicalId(functionName);
    const newFunctionObject = {
      [functionLogicalId]: functionResource,
    };

    Object.assign(cfTemplate.Resources, newFunctionObject);

    const shouldVersionFunction =
      functionObject.versionFunction != null
        ? functionObject.versionFunction
        : this.serverless.service.provider.versionFunctions;

    if (
      shouldVersionFunction ||
      functionObject.provisionedConcurrency ||
      functionObject.snapStart
    ) {
      // Create hashes for the artifact and the logical id of the version resource
      // The one for the version resource must include the function configuration
      // to make sure that a new version is created on configuration changes and
      // not only on source changes.

      if (enforceHashUpdate) {
        functionResource.Properties.Description = 'temporary-description-to-enforce-hash-update';
      }

      const versionHash = crypto.createHash('sha256');
      versionHash.setEncoding('base64');
      const layerConfigurations = _.cloneDeep(
        extractLayerConfigurationsFromFunction(functionResource.Properties, cfTemplate)
      );

      const versionResource = this.cfLambdaVersionTemplate();

      if (functionImageSha) {
        versionResource.Properties.CodeSha256 = functionImageSha;
      } else {
        const fileHash = await getHashForFilePath(artifactFilePath);
        versionResource.Properties.CodeSha256 = fileHash;

        await this.addFileToHash(artifactFilePath, versionHash);
      }
      // Include all referenced layer code in the version id hash
      const layerArtifactPaths = [];
      layerConfigurations.forEach((layer) => {
        const layerArtifactPath = this.provider.resolveLayerArtifactName(layer.name);
        layerArtifactPaths.push(layerArtifactPath);
      });

      for (const layerArtifactPath of layerArtifactPaths.sort()) {
        await this.addFileToHash(layerArtifactPath, versionHash);
      }

      // Include function and layer configuration details in the version id hash
      for (const layerConfig of layerConfigurations) {
        delete layerConfig.properties.Content.S3Key;
      }

      const functionProperties = _.cloneDeep(functionResource.Properties);
      // In `image` case, we assume it's path to ECR image digest
      if (!functionObject.image) delete functionProperties.Code;
      // Properties applied to function globally (not specific to version or alias)
      delete functionProperties.ReservedConcurrentExecutions;
      delete functionProperties.Tags;

      const lambdaHashingVersion = this.serverless.service.provider.lambdaHashingVersion;
      if (lambdaHashingVersion < 20201221 && !this.options['enforce-hash-update']) {
        // sort the layer configurations for hash consistency
        const sortedLayerConfigurations = {};
        const byKey = ([key1], [key2]) => key1.localeCompare(key2);
        for (const { name, properties: layerProperties } of layerConfigurations) {
          sortedLayerConfigurations[name] = _.fromPairs(
            Object.entries(layerProperties).sort(byKey)
          );
        }
        functionProperties.layerConfigurations = sortedLayerConfigurations;
        const sortedFunctionProperties = _.fromPairs(
          Object.entries(functionProperties).sort(byKey)
        );

        versionHash.write(JSON.stringify(sortedFunctionProperties));
      } else {
        functionProperties.layerConfigurations = layerConfigurations;
        versionHash.write(JSON.stringify(deepSortObjectByKey(functionProperties)));
      }

      versionHash.end();
      const versionDigest = versionHash.read();

      versionResource.Properties.FunctionName = { Ref: functionLogicalId };
      if (functionObject.description) {
        versionResource.Properties.Description = functionObject.description;
      }

      // use the version SHA in the logical resource ID of the version because
      // AWS::Lambda::Version resource will not support updates
      const versionLogicalId = this.provider.naming.getLambdaVersionLogicalId(
        functionName,
        versionDigest
      );
      functionObject.versionLogicalId = versionLogicalId;
      const newVersionObject = {
        [versionLogicalId]: versionResource,
      };

      Object.assign(cfTemplate.Resources, newVersionObject);

      // Add function versions to Outputs section
      const functionVersionOutputLogicalId =
        this.provider.naming.getLambdaVersionOutputLogicalId(functionName);
      const newVersionOutput = this.cfOutputLatestVersionTemplate();

      newVersionOutput.Value = { Ref: versionLogicalId };

      Object.assign(cfTemplate.Outputs, {
        [functionVersionOutputLogicalId]: newVersionOutput,
      });

      if (functionObject.provisionedConcurrency && functionObject.snapStart) {
        throw new ServerlessError(
          `Functions with enabled SnapStart does not support provisioned concurrency. Please remove at least one of the settings on function "${functionName}".`,
          'FUNCTION_BOTH_PROVISIONED_CONCURRENCY_AND_SNAPSTART_ENABLED_ERROR'
        );
      }

      if (functionObject.provisionedConcurrency) {
        if (!shouldVersionFunction) delete versionResource.DeletionPolicy;

        const aliasLogicalId =
          this.provider.naming.getLambdaProvisionedConcurrencyAliasLogicalId(functionName);
        const aliasName = this.provider.naming.getLambdaProvisionedConcurrencyAliasName();

        functionObject.targetAlias = { name: aliasName, logicalId: aliasLogicalId };

        const aliasResource = {
          Type: 'AWS::Lambda::Alias',
          Properties: {
            FunctionName: { Ref: functionLogicalId },
            FunctionVersion: { 'Fn::GetAtt': [versionLogicalId, 'Version'] },
            Name: aliasName,
            ProvisionedConcurrencyConfig: {
              ProvisionedConcurrentExecutions: functionObject.provisionedConcurrency,
            },
          },
          DependsOn: functionLogicalId,
        };

        cfTemplate.Resources[aliasLogicalId] = aliasResource;
      }

      if (functionObject.snapStart) {
        if (!shouldVersionFunction) delete versionResource.DeletionPolicy;

        functionResource.Properties.SnapStart = {
          ApplyOn: 'PublishedVersions',
        };

        const aliasLogicalId = this.provider.naming.getLambdaSnapStartAliasLogicalId(functionName);
        const aliasName = this.provider.naming.getLambdaSnapStartEnabledAliasName();

        functionObject.targetAlias = { name: aliasName, logicalId: aliasLogicalId };

        const aliasResource = {
          Type: 'AWS::Lambda::Alias',
          Properties: {
            FunctionName: { Ref: functionLogicalId },
            FunctionVersion: { 'Fn::GetAtt': [versionLogicalId, 'Version'] },
            Name: aliasName,
          },
          DependsOn: functionLogicalId,
        };

        cfTemplate.Resources[aliasLogicalId] = aliasResource;
      }
    }

    this.compileFunctionUrl(functionName);
    this.compileFunctionEventInvokeConfig(functionName);
  }

  compileFunctionUrl(functionName) {
    const functionObject = this.serverless.service.getFunction(functionName);
    const cfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;
    const { url } = functionObject;

    if (!url) return;

    let auth = 'NONE';
    let cors = null;
    if (url.authorizer === 'aws_iam') {
      auth = 'AWS_IAM';
    }

    if (url.cors) {
      cors = Object.assign({}, defaultCors);

      if (url.cors.allowedOrigins) {
        cors.allowedOrigins = _.uniq(url.cors.allowedOrigins);
      } else if (url.cors.allowedOrigins === null) {
        delete cors.allowedOrigins;
      }

      if (url.cors.allowedHeaders) {
        cors.allowedHeaders = _.uniq(url.cors.allowedHeaders);
      } else if (url.cors.allowedHeaders === null) {
        delete cors.allowedHeaders;
      }

      if (url.cors.allowedMethods) {
        cors.allowedMethods = _.uniq(url.cors.allowedMethods);
      } else if (url.cors.allowedMethods === null) {
        delete cors.allowedMethods;
      }

      if (url.cors.allowCredentials) cors.allowCredentials = true;

      if (url.cors.exposedResponseHeaders) {
        cors.exposedResponseHeaders = _.uniq(url.cors.exposedResponseHeaders);
      }

      cors.maxAge = url.cors.maxAge;
    }

    const urlResource = {
      Type: 'AWS::Lambda::Url',
      Properties: {
        AuthType: auth,
        TargetFunctionArn: resolveLambdaTarget(functionName, functionObject),
      },
      DependsOn: _.get(functionObject.targetAlias, 'logicalId'),
    };

    if (cors) {
      urlResource.Properties.Cors = {
        AllowCredentials: cors.allowCredentials,
        AllowHeaders: cors.allowedHeaders && Array.from(cors.allowedHeaders),
        AllowMethods: cors.allowedMethods && Array.from(cors.allowedMethods),
        AllowOrigins: cors.allowedOrigins && Array.from(cors.allowedOrigins),
        ExposeHeaders: cors.exposedResponseHeaders && Array.from(cors.exposedResponseHeaders),
        MaxAge: cors.maxAge,
      };
    }

    if (url.invokeMode === 'RESPONSE_STREAM') {
      urlResource.Properties.InvokeMode = url.invokeMode;
    }

    const logicalId = this.provider.naming.getLambdaFunctionUrlLogicalId(functionName);
    cfTemplate.Resources[logicalId] = urlResource;
    cfTemplate.Outputs[this.provider.naming.getLambdaFunctionUrlOutputLogicalId(functionName)] = {
      Description: 'Lambda Function URL',
      Value: {
        'Fn::GetAtt': [logicalId, 'FunctionUrl'],
      },
    };

    if (auth === 'NONE') {
      cfTemplate.Resources[this.provider.naming.getLambdaFnUrlPermissionLogicalId(functionName)] = {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: resolveLambdaTarget(functionName, functionObject),
          Action: 'lambda:InvokeFunctionUrl',
          Principal: '*',
          FunctionUrlAuthType: auth,
        },
        DependsOn: _.get(functionObject.targetAlias, 'logicalId'),
      };
    }
  }

  compileFunctionEventInvokeConfig(functionName) {
    const functionObject = this.serverless.service.getFunction(functionName);
    const { destinations, maximumEventAge, maximumRetryAttempts } = functionObject;

    if (!destinations && !maximumEventAge && maximumRetryAttempts == null) {
      return;
    }

    const destinationConfig = {};

    if (destinations) {
      const executionRole = this.provider.getCustomExecutionRole(functionObject);
      const hasAccessPoliciesHandledExternally = Boolean(executionRole);

      if (destinations.onSuccess) {
        destinationConfig.OnSuccess = {
          Destination: this.getDestinationsArn(destinations.onSuccess),
        };

        if (!hasAccessPoliciesHandledExternally) {
          this.ensureTargetExecutionPermission(destinations.onSuccess);
        }
      }

      if (destinations.onFailure) {
        destinationConfig.OnFailure = {
          Destination: this.getDestinationsArn(destinations.onFailure),
        };

        if (!hasAccessPoliciesHandledExternally) {
          this.ensureTargetExecutionPermission(destinations.onFailure);
        }
      }
    }

    const cfResources = this.serverless.service.provider.compiledCloudFormationTemplate.Resources;
    const functionLogicalId = this.provider.naming.getLambdaLogicalId(functionName);

    const resource = {
      Type: 'AWS::Lambda::EventInvokeConfig',
      Properties: {
        FunctionName: { Ref: functionLogicalId },
        DestinationConfig: destinationConfig,
        Qualifier: functionObject.targetAlias ? functionObject.targetAlias.name : '$LATEST',
      },
      DependsOn: _.get(functionObject.targetAlias, 'logicalId'),
    };

    if (maximumEventAge) {
      resource.Properties.MaximumEventAgeInSeconds = maximumEventAge;
    }

    if (maximumRetryAttempts != null) {
      resource.Properties.MaximumRetryAttempts = maximumRetryAttempts;
    }

    cfResources[this.provider.naming.getLambdaEventConfigLogicalId(functionName)] = resource;
  }

  getDestinationsArn(destinationsProperty) {
    if (typeof destinationsProperty === 'object') {
      return destinationsProperty.arn;
    }
    return destinationsProperty.startsWith('arn:')
      ? destinationsProperty
      : this.provider.resolveFunctionArn(destinationsProperty);
  }

  // Memoized in a constructor
  ensureTargetExecutionPermission(destinationsProperty) {
    const iamPolicyStatements =
      this.serverless.service.provider.compiledCloudFormationTemplate.Resources
        .IamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement;

    const action = (() => {
      if (typeof destinationsProperty === 'object') {
        if (destinationsProperty.type === 'function') return 'lambda:InvokeFunction';
        if (destinationsProperty.type === 'sqs') return 'sqs:SendMessage';
        if (destinationsProperty.type === 'sns') return 'sns:Publish';
        if (destinationsProperty.type === 'eventBus') return 'events:PutEvents';
      }

      if (typeof destinationsProperty === 'string') {
        if (
          !destinationsProperty.startsWith('arn:') ||
          destinationsProperty.includes(':function:')
        ) {
          return 'lambda:InvokeFunction';
        }
        if (destinationsProperty.includes(':sqs:')) return 'sqs:SendMessage';
        if (destinationsProperty.includes(':sns:')) return 'sns:Publish';
        if (destinationsProperty.includes(':event-bus/')) return 'events:PutEvents';
      }

      throw new ServerlessError(
        `Unsupported destination target ${destinationsProperty}`,
        'UNSUPPORTED_DESTINATION_TARGET'
      );
    })();

    let ResourceArn;
    if (typeof destinationsProperty === 'object') {
      ResourceArn = destinationsProperty.arn;
    } else {
      // Note: Cannot address function via { 'Fn::GetAtt': [targetLogicalId, 'Arn'] }
      // as same IAM settings are used for target function and that will introduce
      // circular dependency error. Relying on Fn::Sub as a workaround
      ResourceArn = destinationsProperty.startsWith('arn:')
        ? destinationsProperty
        : {
            'Fn::Sub': `arn:\${AWS::Partition}:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${
              this.serverless.service.getFunction(destinationsProperty).name
            }`,
          };
    }
    iamPolicyStatements.push({ Effect: 'Allow', Action: action, Resource: ResourceArn });
  }

  async downloadPackageArtifacts() {
    const allFunctions = this.serverless.service.getAllFunctions();
    // download package artifact sequentially one after another
    for (const functionName of allFunctions) {
      await this.downloadPackageArtifact(functionName);
    }
  }

  async compileFunctions() {
    const allFunctions = this.serverless.service.getAllFunctions();
    return Promise.all(allFunctions.map((functionName) => this.compileFunction(functionName)));
  }

  cfLambdaFunctionTemplate() {
    return {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Code: {},
      },
    };
  }

  cfLambdaVersionTemplate() {
    return {
      Type: 'AWS::Lambda::Version',
      // Retain old versions even though they will not be in future
      // CloudFormation stacks. On stack delete, these will be removed when
      // their associated function is removed.
      DeletionPolicy: 'Retain',
      Properties: {
        FunctionName: 'FunctionName',
        CodeSha256: 'CodeSha256',
      },
    };
  }

  cfOutputLatestVersionTemplate() {
    return {
      Description: 'Current Lambda function version',
      Value: 'Value',
    };
  }
}

async function addFileContentsToHashes(filePath, hashes) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(filePath);
    readStream
      .on('data', (chunk) => {
        hashes.forEach((hash) => {
          hash.write(chunk);
        });
      })
      .on('close', () => {
        resolve();
      })
      .on('error', (error) => {
        reject(new Error(`Could not add file content to hash: ${error}`));
      });
  });
}

function extractLayerConfigurationsFromFunction(functionProperties, cfTemplate) {
  const layerConfigurations = [];
  if (!functionProperties.Layers) return layerConfigurations;
  functionProperties.Layers.forEach((potentialLocalLayerObject) => {
    if (potentialLocalLayerObject.Ref) {
      const configuration = cfTemplate.Resources[potentialLocalLayerObject.Ref];

      if (!configuration) {
        log.info(`Could not find reference to layer: ${potentialLocalLayerObject.Ref}.`);
        return;
      }

      layerConfigurations.push({
        name: configuration._serverlessLayerName,
        ref: potentialLocalLayerObject.Ref,
        properties: configuration.Properties,
      });
    }
  });
  return layerConfigurations;
}

module.exports = AwsCompileFunctions;
