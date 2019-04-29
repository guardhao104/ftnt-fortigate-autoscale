'use strict';

/*
FortiGate Autoscale AWS Module (1.0.0)
Author: Fortinet
*/
exports = module.exports;
const path = require('path');
const AWS = require('aws-sdk');
const AutoScaleCore = require('fortigate-autoscale-core');
const Xml2js = require('xml2js');

// lock the API versions
AWS.config.apiVersions = {
    autoscaling: '2011-01-01',
    ec2: '2016-11-15',
    lambda: '2015-03-31',
    dynamodb: '2012-08-10',
    apiGateway: '2015-07-09',
    s3: '2006-03-01'
};

const
    EXPIRE_LIFECYCLE_ENTRY = (process.env.EXPIRE_LIFECYCLE_ENTRY || 60 * 60) * 1000,
    ENABLE_SECOND_NIC = process.env.ENABLE_SECOND_NIC &&
        process.env.ENABLE_SECOND_NIC.trim().toLowerCase() === 'true',
    ENABLE_TGW_VPN = process.env.ENABLE_TGW_VPN &&
        process.env.ENABLE_TGW_VPN.trim().toLowerCase() === 'true',
    autoScaling = new AWS.AutoScaling(),
    dynamodb = new AWS.DynamoDB(),
    docClient = new AWS.DynamoDB.DocumentClient(),
    ec2 = new AWS.EC2(),
    apiGateway = new AWS.APIGateway(),
    s3 = new AWS.S3(),
    RESOURCE_TAG_PREFIX = process.env.RESOURCE_TAG_PREFIX ? process.env.RESOURCE_TAG_PREFIX : '',
    SCRIPT_TIMEOUT = process.env.SCRIPT_TIMEOUT ? process.env.SCRIPT_TIMEOUT : 300,
    DB = AutoScaleCore.dbDefinitions.getTables(RESOURCE_TAG_PREFIX),
    moduleId = AutoScaleCore.uuidGenerator(JSON.stringify(`${__filename}${Date.now()}`)),
    settingItems = AutoScaleCore.settingItems,
    HEART_BEAT_DELAY_ALLOWANCE = 2000; // time in ms allowed to offset the network latency

let logger = new AutoScaleCore.DefaultLogger(console);
/**
 * Implements the CloudPlatform abstraction for the AWS api.
 */
class AwsPlatform extends AutoScaleCore.CloudPlatform {
    async init() {
        let attempts = 0, maxAttempts = 3, done = false, errors;
        while (attempts < maxAttempts) {
            errors = [];
            attempts ++;
            await Promise.all([
                DB.AUTOSCALE, DB.ELECTION, DB.LIFECYCLEITEM, DB.FORTIANALYZER, DB.SETTINGS,
                DB.NICATTACHMENT, DB.CUSTOMLOG]
                .map(table => this.tableExists(table).catch(err => errors.push(err)))
            );
            errors.forEach(err => logger.error(err));
            if (errors.length === 0) {
                done = true;
                break;
            }
        }
        if (Array.isArray(errors) && errors.length > 0) {
            throw new Error(errors.pop());
        }
        return done;
    }

    async createTable(schema) {
        try {
            await dynamodb.describeTable({
                TableName: schema.TableName
            }).promise();
            logger.log(`table ${schema.TableName} exists, no need to create.`);
        } catch (ex) {
            try {
                logger.log('creating table ', schema.TableName);
                await dynamodb.createTable(schema).promise();
            } catch (error) {
                logger.error(`table ${schema.TableName} not created!`);
                logger.error('error:', JSON.stringify(ex), ex);
                throw new Error(`table ${schema.TableName} not created!`);
            }
        }
        await dynamodb.waitFor('tableExists', {
            TableName: schema.TableName
        }).promise();
    }

    async tableExists(schema) {
        try {
            await dynamodb.describeTable({
                TableName: schema.TableName
            }).promise();
            logger.log('found table', schema.TableName);
            return true;
        } catch (ex) {
            logger.error(`table ${schema.TableName} not exists!`);
            logger.error('error:', JSON.stringify(ex), ex);
            throw new Error(`table ${schema.TableName} not exists!`);
        }
    }

    async createTables() {
        let errors = [];
        await Promise.all([
            DB.AUTOSCALE, DB.ELECTION, DB.LIFECYCLEITEM, DB.FORTIANALYZER, DB.SETTINGS,
            DB.NICATTACHMENT, DB.CUSTOMLOG]
            .map(table => this.createTable(table).catch(err => errors.push(err)))
        );
        errors.forEach(err => logger.error(err));
        return errors.length === 0;
    }

    /** @override */
    async getCallbackEndpointUrl(fromContext = null) { // eslint-disable-line no-unused-vars
        // DEBUG:
        // if having issue in getting the remote api in local debug env, try this fake url
        if (process.env.DEBUG_MODE === 'true') {
            return 'http://localhost/no-where';
        }
        let position,
            page;
        const
            gwName = process.env.API_GATEWAY_NAME,
            region = process.env.AWS_REGION,
            stage = process.env.API_GATEWAY_STAGE_NAME,
            resource = process.env.API_GATEWAY_RESOURCE_NAME;
        do {

            this._step = 'handler:getApiGatewayUrl:getRestApis';
            page = await apiGateway.getRestApis({
                position
            }).promise();
            position = page.position;
            const
                gw = page.items.find(i => i.name === gwName);
            if (gw) {
                return `https://${gw.id}.execute-api.${region}.amazonaws.com/` +
                    `${stage}/${resource}`;
            }
        } while (page.items.length);
        throw new Error(`Api Gateway not found looking for ${gwName}`);
    }

    /**
     * @override
     */
    async getLifecycleItems(instanceId) {
        logger.info(`calling getLifecycleItems, instanceId: ${instanceId}`);
        const query = {
                TableName: DB.LIFECYCLEITEM.TableName,
                KeyConditionExpression: '#InstanceId = :InstanceId',
                ExpressionAttributeNames: {
                    '#InstanceId': 'instanceId'
                },
                ExpressionAttributeValues: {
                    ':InstanceId': instanceId
                }
            },
            response = await docClient.query(query).promise(),
            items = response.Items;
        if (!items || !Array.isArray(items)) {
            logger.info('called getLifecycleItems. No pending lifecycle action.');
            return [];
        }
        logger.info('called getLifecycleItems. ' +
            `[${items.length}] pending lifecycle action. response: ${JSON.stringify(items)}`);
        return items.map(item => AutoScaleCore.LifecycleItem.fromDb(item));
    }
    /**
     * @param {LifecycleItem} item Item containing the data to store.
     */
    async updateLifecycleItem(item) {
        const params = {
            TableName: DB.LIFECYCLEITEM.TableName,
            Item: item.toDb()
        };
        return await docClient.put(params).promise();
    }

    /**
     * remove one life cycle action item hooked with an instance.
     * Abstract class method.
     * @param {LifecycleItem} item Item used by the platform to complete
     *  a lifecycleAction.
     */
    async removeLifecycleItem(item) {
        logger.info('calling removeLifecycleItem');
        return await docClient.delete({
            TableName: DB.LIFECYCLEITEM.TableName,
            Key: {
                instanceId: item.instanceId,
                actionName: item.actionName
            }
        }).promise();
    }

    /**
     * @override
     */
    async cleanUpDbLifeCycleActions(items = []) {
        try {
            const tableName = DB.LIFECYCLEITEM.TableName;
            if (!items || Array.isArray(items) && items.length === 0) {

                const
                    response = await docClient.scan({
                        TableName: tableName,
                        Limit: 5
                    })
                    .promise();
                items = response.Items;
                if (Array.isArray(items) && items.length) {
                    return await this.cleanUpDbLifeCycleActions(items);
                }
            } else {
                logger.info('calling cleanUpDbLifeCycleActions');
                let itemToRemove = [],
                    awaitAll = [];
                let remove = async item => {
                    return await this.removeLifecycleItem(item);
                };
                items.forEach(item => {
                    if (Date.now() - item.timestamp > EXPIRE_LIFECYCLE_ENTRY) {
                        awaitAll.push(remove(item));
                        itemToRemove.push(item);
                    }
                });
                await Promise.all(awaitAll);
                logger.info(`cleaned up items: ${JSON.stringify(itemToRemove)}`);
                return true;
            }
        } catch (ex) {
            console.error('Error while cleaning up (ignored):', ex);
        }
        return false;
    }

    async completeLifecycleAction(lifecycleItem, success) {
        logger.info('calling completeLifecycleAction');
        try {
            await this.updateLifecycleItem(lifecycleItem);
            var params = {
                AutoScalingGroupName: lifecycleItem.detail.AutoScalingGroupName,
                LifecycleActionResult: success ? 'CONTINUE' : 'ABANDON',
                LifecycleActionToken: lifecycleItem.detail.LifecycleActionToken,
                LifecycleHookName: lifecycleItem.detail.LifecycleHookName
                // InstanceId: event.instanceId
            };
            if (!process.env.DEBUG_MODE) {
                await autoScaling.completeLifecycleAction(params).promise();
            }
            // TODO: remove lifecycle Item here
            await this.removeLifecycleItem(lifecycleItem);
            logger.info(
                `[${params.LifecycleActionResult}] applied to hook[${params.LifecycleHookName}] with
            token[${params.LifecycleActionToken}] in auto scaling group
            [${params.AutoScalingGroupName}]`);
            return true;
        } catch (error) {
            logger.warn(`called completeLifecycleAction. warning:${error.message}`);
            return false;
        }
    }

    /** @override */
    async putMasterRecord(candidateInstance, voteState, method = 'new') {
        try {
            let params = {
                TableName: DB.ELECTION.TableName,
                Item: {
                    asgName: this.scalingGroupName,
                    ip: candidateInstance.primaryPrivateIpAddress,
                    instanceId: candidateInstance.instanceId,
                    vpcId: candidateInstance.virtualNetworkId,
                    subnetId: candidateInstance.subnetId,
                    voteEndTime: Date.now() + (SCRIPT_TIMEOUT - 1) * 1000,
                    voteState: voteState
                }
            };
            if (method !== 'replace') {
                params.ConditionExpression = 'attribute_not_exists(asgName)';
            }
            return !!await docClient.put(params).promise();
        } catch (error) {
            logger.warn('error occurs in putMasterRecord:', JSON.stringify(error));
            return false;
        }
    }

    /** @override */
    async getMasterRecord() {
        const
            params = {
                TableName: DB.ELECTION.TableName,
                FilterExpression: '#PrimaryKeyName = :primaryKeyValue',
                ExpressionAttributeNames: {
                    '#PrimaryKeyName': 'asgName'
                },
                ExpressionAttributeValues: {
                    ':primaryKeyValue': this.scalingGroupName
                }
            },
            response = await docClient.scan(params).promise(),
            items = response.Items;
        if (!items || items.length === 0) {
            logger.info('No elected master was found in the db!');
            return null;
        }
        logger.info(`Elected master found: ${JSON.stringify(items[0])}`, JSON.stringify(items));
        return items[0];
    }

    /** @override */
    async removeMasterRecord() {
        // only purge the master with a done votestate to avoid a
        // race condition
        const params = {
            TableName: DB.ELECTION.TableName,
            Key: {
                asgName: this.masterScalingGroupName
            },
            ConditionExpression: '#AsgName = :asgName',
            ExpressionAttributeNames: {
                '#AsgName': 'asgName'
            },
            ExpressionAttributeValues: {
                ':asgName': this.masterScalingGroupName
            }
        };
        return await docClient.delete(params).promise();
    }

    async finalizeMasterElection() {
        try {
            logger.info('calling finalizeMasterElection');
            let electedMaster = this._masterRecord || await this.getMasterRecord();
            electedMaster.voteState = 'done';
            const params = {
                TableName: DB.ELECTION.TableName,
                Item: electedMaster
            };
            let result = await docClient.put(params).promise();
            logger.info(`called finalizeMasterElection, result: ${JSON.stringify(result)}`);
            return !!result;
        } catch (ex) {
            logger.warn('called finalizeMasterElection, error:', ex.stack);
            return false;
        }
    }


    /**
     * get the health check info about an instance been monitored.
     * @param {Object} instance instance object which a vmId property is required.
     * @param {Number} heartBeatInterval integer value, unit is second.
     */
    async getInstanceHealthCheck(instance, heartBeatInterval = null) {
        if (!(instance && instance.instanceId)) {
            logger.error('getInstanceHealthCheck > error: no instanceId property found' +
                ` on instance: ${JSON.stringify(instance)}`);
            return Promise.reject(`invalid instance: ${JSON.stringify(instance)}`);
        }
        var params = {
            Key: {
                instanceId: instance.instanceId
            },
            TableName: DB.AUTOSCALE.TableName
        };
        try {
            let compensatedScriptTime,
                healthy,
                heartBeatLossCount,
                interval,
                data = await docClient.get(params).promise();
            if (data.Item) {
                // to get a more accurate heart beat elapsed time, the script execution time so far
                // is compensated.
                compensatedScriptTime = process.env.SCRIPT_EXECUTION_TIME_CHECKPOINT;
                interval = heartBeatInterval && !isNaN(heartBeatInterval) ?
                    heartBeatInterval : data.Item.heartBeatInterval;
                // based on the test results, network delay brought more significant side effects
                // to the heart beat monitoring checking than we thought. we have to expand the
                // checking time to reasonably offset the delay.
                // HEART_BEAT_DELAY_ALLOWANCE is used for this purpose
                if (compensatedScriptTime <
                    data.Item.nextHeartBeatTime + HEART_BEAT_DELAY_ALLOWANCE) {
                    // reset hb loss count if instance sends hb within its interval
                    healthy = true;
                    heartBeatLossCount = 0;
                } else {
                    // if the current sync heartbeat is late, the instance is still considered
                    // healthy unless 3 times of heartBeatInterval amount of time has passed.
                    // in other words, the instance totally lost the time of 3 hb syncing
                    // network delay allowance also applies to the case here.
                    healthy = data.Item.heartBeatLossCount < 3 &&
                        Date.now() < data.Item.nextHeartBeatTime + HEART_BEAT_DELAY_ALLOWANCE +
                        interval * 1000 * (2 - data.Item.heartBeatLossCount);
                    heartBeatLossCount = data.Item.heartBeatLossCount + 1;
                }
                logger.info('called getInstanceHealthCheck. (timestamp: ' +
                `${compensatedScriptTime},  interval:${heartBeatInterval}) healthcheck record:`,
                JSON.stringify(data.Item));
                return {
                    instanceId: instance.instanceId,
                    healthy: healthy,
                    heartBeatLossCount: heartBeatLossCount,
                    heartBeatInterval: interval,
                    nextHeartBeatTime: Date.now() + interval * 1000,
                    masterIp: data.Item.masterIp,
                    syncState: data.Item.syncState,
                    inSync: data.Item.syncState === 'in-sync'
                };
            } else {
                logger.info('called getInstanceHealthCheck: no record found');
                return null;
            }
        } catch (error) {
            logger.info('called getInstanceHealthCheck with error. ' +
                `error: ${JSON.stringify(error)}`);
            return null;
        }
    }

    /** @override */
    async updateInstanceHealthCheck(healthCheckObject, heartBeatInterval, masterIp, checkPointTime,
        forceOutOfSync = false) {
        if (!(healthCheckObject && healthCheckObject.instanceId)) {
            logger.error('updateInstanceHealthCheck > error: no instanceId property found' +
                ` on healthCheckObject: ${JSON.stringify(healthCheckObject)}`);
            return Promise.reject('invalid healthCheckObject: ' +
                `${JSON.stringify(healthCheckObject)}`);
        }
        try {
            let params = {
                Key: {
                    instanceId: healthCheckObject.instanceId
                },
                TableName: DB.AUTOSCALE.TableName,
                UpdateExpression: 'set heartBeatLossCount = :HeartBeatLossCount, ' +
                    'heartBeatInterval = :heartBeatInterval, ' +
                    'nextHeartBeatTime = :NextHeartBeatTime, ' +
                    'masterIp = :MasterIp, syncState = :SyncState',
                ExpressionAttributeValues: {
                    ':HeartBeatLossCount': healthCheckObject.heartBeatLossCount,
                    ':heartBeatInterval': heartBeatInterval,
                    ':NextHeartBeatTime': checkPointTime + heartBeatInterval * 1000,
                    ':MasterIp': masterIp ? masterIp : 'null',
                    ':SyncState': healthCheckObject.healthy && !forceOutOfSync ?
                        'in-sync' : 'out-of-sync'
                },
                ConditionExpression: 'attribute_exists(instanceId)'
            };
            if (!forceOutOfSync) {
                params.ConditionExpression += ' AND syncState = :SyncState';
            }
            let result = await docClient.update(params).promise();
            logger.info('called updateInstanceHealthCheck');
            return !!result;
        } catch (error) {
            logger.info('called updateInstanceHealthCheck with error. ' +
                `error: ${JSON.stringify(error)}`);
            return Promise.reject(error);
        }
    }

    /** @override */
    async deleteInstanceHealthCheck(instanceId) {
        try {
            let params = {
                TableName: DB.AUTOSCALE.TableName,
                Key: {
                    instanceId: instanceId
                }
            };
            let result = await docClient.delete(params).promise();
            return !!result;
        } catch (error) {
            logger.warn('called deleteInstanceHealthCheck. error:', error);
            return false;
        }
    }

    async describeAutoScalingGroups(groupName) {
        try {
            let params = {
                AutoScalingGroupNames: [groupName]
            };
            let data = await autoScaling.describeAutoScalingGroups(params).promise();
            if (data && data.AutoScalingGroups && data.AutoScalingGroups.length > 0) {
                logger.info('called describeAutoScalingGroups. group found.');
                let groups = data.AutoScalingGroups.filter(group => {
                    return group.AutoScalingGroupName === groupName;
                });
                return groups && groups.length && groups[0];
            }
        } catch (error) {
            logger.warn('called describeAutoScalingGroups, error:', error);
        }
        logger.info('called describeAutoScalingGroups, no matching group found.');
        return null;
    }

    /* eslint-disable max-len */
    /**
     * Get information about an instance by the given parameters.
     * @see https://docs.aws.amazon.com/opsworks/latest/APIReference/API_DescribeInstances.html
     * @see https://docs.aws.amazon.com/autoscaling/ec2/APIReference/API_DescribeAutoScalingInstances.html
     * @param {Object} parameters parameters accepts: instanceId, privateIp, publicIp
     */
    /* eslint-enable max-len */
    async describeInstance(parameters) {
        logger.info('calling describeInstance');
        let params = {
                Filters: []
            },
            instanceId;
        // check if instance is in scaling group
        if (parameters.scalingGroupName) {
            // describe the instance in auto scaling group
            let scalingGroup = await autoScaling.describeAutoScalingGroups({
                AutoScalingGroupNames: [
                    parameters.scalingGroupName
                ]
            }).promise();
            if (scalingGroup && Array.isArray(scalingGroup.AutoScalingGroups) &&
                scalingGroup.AutoScalingGroups[0] &&
                scalingGroup.AutoScalingGroups[0].AutoScalingGroupName ===
                parameters.scalingGroupName) {
                const instances = scalingGroup.AutoScalingGroups[0].Instances.filter(instance => {
                    return instance.InstanceId === parameters.instanceId;
                });
                if (instances && instances.length === 1) {
                    instanceId = instances[0].InstanceId;
                }
            }
        } else if (parameters.instanceId) {
            instanceId = parameters.instanceId;
        }
        // describe the instance
        if (instanceId) {
            params.Filters.push({
                Name: 'instance-id',
                Values: [parameters.instanceId]
            });
        }
        if (parameters.publicIp) {
            params.Filters.push({
                Name: 'ip-address',
                Values: [parameters.publicIp]
            });
        }
        if (parameters.privateIp) {
            params.Filters.push({
                Name: 'private-ip-address',
                Values: [parameters.privateIp]
            });
        }
        const result = instanceId && await ec2.describeInstances(params).promise();
        logger.info(`called describeInstance, result: ${result ? JSON.stringify(result) : 'null'}`);
        return result && result.Reservations[0] && result.Reservations[0].Instances[0] &&
            AutoScaleCore.VirtualMachine.fromAwsEc2(
                result.Reservations[0] && result.Reservations[0].Instances[0],
                parameters.scalingGroupName || null);
    }

    /**
     * Extract useful info from request event.
     * @param {Object} request the request event
     * @returns {Array} an array of required info per platform.
     */
    extractRequestInfo(request) {
        let instanceId = null,
            interval = null,
            status = null;

        if (request && request.headers && request.headers['Fos-instance-id']) {
            instanceId = request.headers['Fos-instance-id'];
        } else if (request && request.body) {
            try {
                let jsonBodyObject = JSON.parse(request.body);
                instanceId = jsonBodyObject.instance;
                if (jsonBodyObject.interval) {
                    interval = jsonBodyObject.interval;
                }
                status = jsonBodyObject.status;
            } catch (ex) {
                logger.info('calling extractRequestInfo: unexpected body content format ' +
                    `(${request.body})`);
            }
        } else {
            logger.error('calling extractRequestInfo: no request body found.');
        }

        logger.info(`called extractRequestInfo: extracted: instance Id(${instanceId}), ` +
            `interval(${interval}), status(${status})`);
        return {
            instanceId,
            interval,
            status
        };
    }

    async createNetworkInterface(parameters) {
        try {
            logger.info('calling createNetworkInterface');
            let result = await ec2.createNetworkInterface(parameters).promise();
            // create a tag
            if (result && result.NetworkInterface) {
                let params = {
                    Resources: [
                        result.NetworkInterface.NetworkInterfaceId
                    ],
                    Tags: [{
                        Key: 'FortiGateAutoscaleNicAttachment',
                        Value: RESOURCE_TAG_PREFIX
                    },{
                        Key: 'Name',
                        Value: `${RESOURCE_TAG_PREFIX}-fortigate-autoscale-instance-nic2`
                    },{
                        Key: 'ResourceGroup',
                        Value: RESOURCE_TAG_PREFIX
                    }]
                };
                await ec2.createTags(params).promise();
            }
            return result && result.NetworkInterface;
        } catch (error) {
            logger.warn(`called createNetworkInterface. failed.(error: ${JSON.stringify(error)})`);
            return false;
        }
    }

    async deleteNetworkInterface(parameters) {
        try {
            logger.info('called deleteNetworkInterface');
            return await ec2.deleteNetworkInterface(parameters).promise();
        } catch (error) {
            logger.warn(`called deleteNetworkInterface. failed.(error: ${JSON.stringify(error)})`);
            return false;
        }
    }

    async describeNetworkInterface(parameters) {
        try {
            logger.info('called describeNetworkInterface');
            let result = await ec2.describeNetworkInterfaces(parameters).promise();
            return result && result.NetworkInterfaces && result.NetworkInterfaces[0];
        } catch (error) {
            logger.warn('called describeNetworkInterface. ' +
                `failed.(error: ${JSON.stringify(error)})`);
            return false;
        }
    }

    async listNetworkInterfaces(parameters) {
        try {
            logger.info('called listNetworkInterfaces');
            let result = await ec2.describeNetworkInterfaces(parameters).promise();
            return result && result.NetworkInterfaces;
        } catch (error) {
            logger.warn('called listNetworkInterfaces. ' +
                `failed.(error: ${JSON.stringify(error)})`);
            return false;
        }
    }

    async attachNetworkInterface(instance, nic) {
        logger.info('calling attachNetworkInterface');
        if (!instance || !instance.networkInterfaces) {
            logger.warn(`invalid instance: ${JSON.stringify(instance)}`);
            return false;
        } else if (!nic) {
            logger.warn(`invalid network interface controller: ${JSON.stringify(nic)}`);
            return false;
        }
        try {
            let params = {
                DeviceIndex: instance.networkInterfaces.length,
                InstanceId: instance.instanceId,
                NetworkInterfaceId: nic.NetworkInterfaceId
            };
            await ec2.attachNetworkInterface(params).promise();
            let promiseEmitter = () => {
                    return ec2.describeNetworkInterfaces({
                        NetworkInterfaceIds: [nic.NetworkInterfaceId]
                    }).promise();
                },
                validator = result => {
                    return result && result.NetworkInterfaces && result.NetworkInterfaces[0] &&
                        result.NetworkInterfaces[0].Attachment &&
                        result.NetworkInterfaces[0].Attachment.Status === 'attached';
                };
            let result = await AutoScaleCore.waitFor(promiseEmitter, validator);
            logger.info('called attachNetworkInterface. ' +
                `done.(attachment id: ${result.NetworkInterfaces[0].Attachment.AttachmentId})`);
            return result.NetworkInterfaces[0].Attachment.AttachmentId;
        } catch (error) {
            await this.deleteNicAttachmentRecord(instance.instanceId, 'pending_attach');
            logger.warn(`called attachNetworkInterface. failed.(error: ${JSON.stringify(error)})`);
            return false;
        }
    }

    async detachNetworkInterface(instance, nic) {
        logger.info('calling detachNetworkInterface');
        if (!instance || !instance.networkInterfaces) {
            logger.warn(`invalid instance: ${JSON.stringify(instance)}`);
            return false;
        } else if (!nic) {
            logger.warn(`invalid network interface controller: ${JSON.stringify(nic)}`);
            return false;
        }
        let attachedNic = instance.networkInterfaces.some(item => {
            return item.NetworkInterfaceId === nic.NetworkInterfaceId;
        });
        if (!attachedNic) {
            logger.warn(`nic(id: ${nic.NetworkInterfaceId}) is not attached to ` +
                `instance(id: ${instance.instanceId})`);
            return false;
        }
        try {
            let params = {
                AttachmentId: nic.Attachment.AttachmentId
            };
            await ec2.detachNetworkInterface(params).promise();
            let promiseEmitter = () => {
                    return ec2.describeNetworkInterfaces({
                        NetworkInterfaceIds: [nic.NetworkInterfaceId]
                    }).promise();
                },
                validator = result => {
                    return result && result.NetworkInterfaces && result.NetworkInterfaces[0] &&
                        result.NetworkInterfaces[0] &&
                        result.NetworkInterfaces[0].Status === 'available';
                };
            let result = await AutoScaleCore.waitFor(promiseEmitter, validator);
            logger.info('called detachNetworkInterface. ' +
                `done.(nic status: ${result.NetworkInterfaces[0].Status})`);
            return result.NetworkInterfaces[0].Status === 'available';
        } catch (error) {
            logger.warn(`called detachNetworkInterface. failed.(error: ${JSON.stringify(error)})`);
            return false;
        }
    }

    async listNicAttachmentRecord() {
        try {
            const
                response = await docClient.scan({
                    TableName: DB.NICATTACHMENT.TableName
                }).promise();
            let recordCount = 0,
                records = [];
            if (response && response.Items) {
                recordCount = response.Items.length;
                records = response.Items;
            }
            logger.info(`called listNicAttachmentRecord: found ${recordCount} records.`);
            return records;
        } catch (error) {
            logger.info('called listNicAttachmentRecord: error:', error);
            return null;
        }
    }

    async getNicAttachmentRecord(instanceId) {
        let params = {
            TableName: DB.NICATTACHMENT.TableName,
            Key: {
                instanceId: instanceId
            }
        };
        try {
            let result = await docClient.get(params).promise();
            return result && result.Item;
        } catch (error) {
            return null;
        }
    }

    async updateNicAttachmentRecord(instanceId, nicId, state, conditionState = null) {
        let params = {
            Key: {
                instanceId: instanceId
            },
            TableName: DB.NICATTACHMENT.TableName
        };
        if (conditionState) {
            params.UpdateExpression = 'set nicId = :NicId, attachmentState = :State';
            params.ExpressionAttributeValues = {
                ':NicId': nicId,
                ':State': state
            };
            return await docClient.update(params).promise();
        } else {
            params.Item = {
                instanceId: instanceId,
                nicId: nicId,
                attachmentState: state
            };
            params.ConditionExpression = 'attribute_not_exists(instanceId)';
            return await docClient.put(params).promise();
        }
    }

    async deleteNicAttachmentRecord(instanceId, conditionState = null) {
        let params = {
            TableName: DB.NICATTACHMENT.TableName,
            Key: {
                instanceId: instanceId
            }
        };
        if (conditionState) {
            params.ConditionExpression = 'attachmentState = :State';
            params.ExpressionAttributeValues = {
                ':State': conditionState
            };
        }
        try {
            return await docClient.delete(params).promise();
        } catch (error) {
            return error;
        }
    }

    async getSettingItem(key, valueOnly = true) {
        let params = {
            TableName: DB.SETTINGS.TableName,
            Key: {
                settingKey: key
            }
        };
        try {
            let result = await docClient.get(params).promise();
            if (result && result.Item) {
                let value = result.Item.jsonEncoded !== 'false' ?
                    JSON.parse(result.Item.settingValue) : result.Item.settingValue;
                if (valueOnly) {
                    return value;
                } else {
                    return {settingKey: result.Item.settingKey, settingValue: value,
                        description: result.Item.description};
                }
            }
        } catch (error) {
            return null;
        }
    }

    /**
     * add or update a setting item with given key. If description is null, it will be kept
     * unchanged when updating an existing item, or converted to an empty string when adding new.
     * @param {String} key the Key
     * @param {any} value the value
     * @param {String} description the description
     * @param {Boolean} jsonEncoded set to true if value needs to store as json encoded
     * @param {Boolean} editable set to true if this setting is allowed to change
     */
    async setSettingItem(key, value, description = null, jsonEncoded = false, editable = false) {
        let params = {
            TableName: DB.SETTINGS.TableName,
            Key: { settingKey: key},
            ExpressionAttributeNames: {
                '#settingValue': 'settingValue',
                '#jsonEncoded': 'jsonEncoded',
                '#editable': 'editable'
            },
            ExpressionAttributeValues: {
                ':settingValue': jsonEncoded ? JSON.stringify(value) : value,
                ':jsonEncoded': jsonEncoded ? 'true' : 'false',
                ':editable': editable ? 'true' : 'false'
            },
            UpdateExpression: 'SET #settingValue = :settingValue, #jsonEncoded = :jsonEncoded' +
            ', #editable = :editable'
        };
        if (description !== null) {
            params.ExpressionAttributeNames['#description'] = 'description';
            params.ExpressionAttributeValues[':description'] = description ? description : '';
            params.UpdateExpression += ', #description = :description';
        }
        return !!await docClient.update(params).promise();
    }

    /** @override */
    async getBlobFromStorage(parameters) {
        let content = '';
        // DEBUG:
        // for local debugging use, the next lines get files from local file system instead
        if (process.env.DEBUG_MODE === 'true') {
            const fs = require('fs');
            content = fs.readFileSync(path.resolve(process.cwd(),
            'aws_cloudformation', 'assets', 'configset', parameters.fileName));
            return {
                content: content.toString()
            };
        }
        let data = await s3.getObject({
            Bucket: process.env.STACK_ASSETS_S3_BUCKET_NAME,
            Key: path.join(process.env.STACK_ASSETS_S3_KEY_PREFIX, parameters.path,
                parameters.fileName)
        }).promise();

        content = data && data.Body && data.Body.toString('utf8');
        return {
            content: content
        };
    }

    async terminateInstanceInAutoScalingGroup(instance) {
        logger.info('calling terminateInstanceInAutoScalingGroup');
        let params = {
            InstanceId: instance.instanceId,
            ShouldDecrementDesiredCapacity: false
        };
        try {
            let result = await autoScaling.terminateInstanceInAutoScalingGroup(params).promise();
            logger.info('called terminateInstanceInAutoScalingGroup. done.', result);
            return true;
        } catch (error) {
            logger.warn('called terminateInstanceInAutoScalingGroup. failed.', error);
            return false;
        }
    }

    async saveLogToDb(log) {
        let timestamp = Date.now(),
            document = {
                id: `${RESOURCE_TAG_PREFIX}-LOG-${timestamp}`,
                logContent: typeof log === 'string' ? log : JSON.stringify(log),
                timestamp: timestamp
            };
        try {
            const params = {
                TableName: DB.CUSTOMLOG.TableName,
                Item: document
            };
            return await docClient.put(params).promise(); // create new or replace existing
        } catch (error) {
            logger.warn('called saveLogToDb > error: ', error, 'document item:', document);
            return false;
        }
    }

    // eslint-disable-next-line no-unused-vars
    async listLogFromDb(timeFrom, timeTo = null) {
        try {
            let query = {
                TableName: DB.CUSTOMLOG.TableName,
                KeyConditionExpression: '#Timestamp >= :TimeFrom',
                ExpressionAttributeNames: {
                    '#Timestamp': 'id'
                },
                ExpressionAttributeValues: {
                    ':TimeFrom': timeFrom
                }
            };
            if (timeTo) {
                query.KeyConditionExpression += ' AND #Timestamp <= :TimeTo';
                query.ExpressionAttributeValues[':TimeTo'] = timeTo;
            }
            let response = await docClient.query(query).promise();
            if (!Array.isArray(response.Items) || response.Items.length === 0) {
                return '';
            }
            return response.Items.join('');
        } catch (error) {
            return '';
        }
    }

    async deleteLogFromDb(timeFrom, timeTo = null) {
        try {
            let query = {
                TableName: DB.CUSTOMLOG.TableName,
                KeyConditionExpression: '#Timestamp >= :TimeFrom',
                ExpressionAttributeNames: {
                    '#Timestamp': 'id'
                },
                ExpressionAttributeValues: {
                    ':TimeFrom': timeFrom
                }
            };
            if (timeTo) {
                query.KeyConditionExpression += ' AND #Timestamp <= :TimeTo';
                query.ExpressionAttributeValues[':TimeTo'] = timeTo;
            }

            let response = await docClient.query(query).promise();
            if (!Array.isArray(response.Items) || response.Items.length === 0) {
                return false;
            }
            let deletionTasks = [],
                errorTasks = [],
                baseParams = {
                    Key: {},
                    TableName: DB.CUSTOMLOG.TableName,
                    ConditionExpression: '#Timestamp = :Timestamp',
                    ExpressionAttributeNames: {
                        '#Timestamp': 'id'
                    }
                };
            response.Items.forEach(item => {
                let params;
                Object.assign(params, baseParams);
                params.ExpressionAttributeValues = {
                    ':Timestamp': item.timestamp
                };
                deletionTasks.push(docClient.delete(params).promise().catch(() => {
                    errorTasks.push(item);
                }));
            });

            await Promise.all(deletionTasks);
            return `${deletionTasks.length} rows deleted. ${errorTasks.length} error rows.`;

        } catch (error) {
            return false;
        }
    }

    async createCustomerGateway(parameters) {
        try {
            logger.info('calling createCustomerGateway');
            let params = {
                    BgpAsn: parameters.bgpAsn,
                    PublicIp: parameters.publicIp,
                    Type: parameters.type ? parameters.type : 'ipsec.1'
                },
                result = await ec2.createCustomerGateway(params).promise();
            if (result && result.CustomerGateway) {
                params = {
                    Resources: [
                        result.CustomerGateway.CustomerGatewayId
                    ],
                    Tags: [{
                        Key: 'FortiGateAutoscaleTgwVpnAttachment',
                        Value: RESOURCE_TAG_PREFIX
                    },{
                        Key: 'Name',
                        Value: `${RESOURCE_TAG_PREFIX}-fortigate-autoscale-` +
                        `cgw-${parameters.publicIp}`
                    },{
                        Key: 'ResourceGroup',
                        Value: RESOURCE_TAG_PREFIX
                    }]
                };
                await ec2.createTags(params).promise();
            }
            logger.info('called createCustomerGateway');
            return result && result.CustomerGateway;
        } catch (error) {
            logger.warn(`called createCustomerGateway. failed.(error: ${JSON.stringify(error)})`);
            return false;
        }
    }

    async deleteCustomerGateway(parameters) {
        try {
            logger.info('calling deleteCustomerGateway');
            let params;
            params = {
                CustomerGatewayId: parameters.customerGatewayId
            };
            await ec2.deleteCustomerGateway(params).promise();
            logger.info('called deleteCustomerGateway');
            return true;
        } catch (error) {
            logger.warn(`called deleteCustomerGateway. failed > error: ${JSON.stringify(error)})`);
            return false;
        }
    }

    async createVpnConnection(parameters) {
        try {
            logger.info('calling createVpnConnection');
            let params;
            params = {
                CustomerGatewayId: parameters.customerGatewayId,
                Type: parameters.type,
                Options: {
                    StaticRoutesOnly: false
                }
            };
            if (parameters.transitGatewayId) {
                params.TransitGatewayId = parameters.transitGatewayId;
            }
            let result = await ec2.createVpnConnection(params).promise();
            if (result && result.VpnConnection) {
                // tag the vpnconnection
                params = {
                    Resources: [
                        result.VpnConnection.VpnConnectionId
                    ],
                    Tags: [{
                        Key: 'FortiGateAutoscaleTgwVpnAttachment',
                        Value: RESOURCE_TAG_PREFIX
                    },{
                        Key: 'Name',
                        Value: `${RESOURCE_TAG_PREFIX}-fortigate-autoscale-` +
                        `vpn-${parameters.publicIp}`
                    },{
                        Key: 'ResourceGroup',
                        Value: RESOURCE_TAG_PREFIX
                    }]
                };
                logger.info('creating tags on the vpnconnection. tags: ', JSON.stringify(params));
                await ec2.createTags(params).promise();
                // if this vpn is created for a transit gateway, tag the tgw attachment
                // describe the tgw attachment
                // NOTE: it might not be accessible immediately after the vpn connection is created
                // wait for it

                if (parameters.transitGatewayId) {
                    let vpnConnectionId = result.VpnConnection.VpnConnectionId, tgwAttachment, data;
                    logger.info('describing transit gateway attachment' +
                        `(vpn connection: ${vpnConnectionId}).`);
                    params = {
                        Filters: [
                            {
                                Name: 'resource-id',
                                Values: [
                                    vpnConnectionId
                                ]
                            },
                            {
                                Name: 'transit-gateway-id',
                                Values: [
                                    parameters.transitGatewayId
                                ]
                            }
                        ]
                    };
                    let promiseEmitter = params => {
                        let promise = ec2.describeTransitGatewayAttachments(params).promise();
                        promise.catch(error => {
                            logger.warn('error in describeTransitGatewayAttachments ' +
                                `>${JSON.stringify(error)}`);
                        });
                        return promise;
                    };
                    let validator = result => {
                        logger.debug(`TransitGatewayAttachments: ${JSON.stringify(result)}`);
                        if (result && result.TransitGatewayAttachments &&
                            result.TransitGatewayAttachments.length > 0) {
                            // NOTE: by the time April 26, 2019. the AWS JavascriptSDK
                            // ec2.describeTransitGatewayAttachments cannot properly filter resource
                            // by resource-id. instead, it always return all resources so we must
                            // do the filtering in the function here.
                            // eslint-disable-next-line max-len
                            // ref link: https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html#describeTransitGatewayAttachments-property
                            let attachmentFound = null;
                            attachmentFound = result.TransitGatewayAttachments.find(attachment => {
                                return attachment.ResourceId === vpnConnectionId &&
                                attachment.TransitGatewayId === parameters.transitGatewayId;
                            });
                            logger.debug(`attachmentFound: ${JSON.stringify(attachmentFound)}`);
                            return !!attachmentFound;
                        }
                        return false;
                    };

                    try {
                        data = await AutoScaleCore.waitFor(promiseEmitter, validator, 5000, 5);
                    } catch (error) {
                        logger.error(JSON.stringify(error));
                        logger.warn('failed to tag the transit gateway attachment for vpn' +
                        `connetion (id: ${vpnConnectionId}). skip tagging it.`);
                    }
                    logger.info('transit gateway attachment info: ', JSON.stringify(data));
                    if (data) {
                        // NOTE: by the time April 26, 2019. the AWS JavascriptSDK
                        // ec2.describeTransitGatewayAttachments cannot properly filter resource
                        // by resource-id. instead, it always return all resources so we must
                        // do the filtering in the function here.
                        // eslint-disable-next-line max-len
                        // ref link: https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html#describeTransitGatewayAttachments-property
                        tgwAttachment = data.TransitGatewayAttachments.find(attachment => {
                            return attachment.ResourceId === vpnConnectionId &&
                                attachment.TransitGatewayId === parameters.transitGatewayId;
                        });
                        if (tgwAttachment) {
                            params = {
                                Resources: [
                                    tgwAttachment.TransitGatewayAttachmentId
                                ],
                                Tags: [{
                                    Key: 'FortiGateAutoscaleTgwVpnAttachment',
                                    Value: RESOURCE_TAG_PREFIX
                                },{
                                    Key: 'Name',
                                    Value: `${RESOURCE_TAG_PREFIX}-fortigate-autoscale-` +
                                    `tgw-attachment-vpn-${parameters.publicIp}`
                                },{
                                    Key: 'ResourceGroup',
                                    Value: RESOURCE_TAG_PREFIX
                                }]
                            };
                            logger.info('creating tags on attachment. tags: ',
                                JSON.stringify(params));
                            await ec2.createTags(params).promise();
                        }
                    }
                }
            }
            logger.info('called createVpnConnection');
            return result && result.VpnConnection;
        } catch (error) {
            logger.warn(`called createVpnConnection. failed.(error: ${JSON.stringify(error)})`);
            return false;
        }
    }

    async deleteVpnConnection(parameters) {
        try {
            logger.info('calling deleteVpnConnection');
            let params;
            params = {
                VpnConnectionId: parameters.vpnConnectionId
            };
            await ec2.deleteVpnConnection(params).promise();
            logger.info('called deleteVpnConnection');
            return true;
        } catch (error) {
            logger.warn(`called deleteVpnConnection. failed > error: ${JSON.stringify(error)})`);
            return false;
        }
    }

    async getTgwVpnAttachmentRecord(instance) {
        let params = {
            TableName: DB.VPNATTACHMENT.TableName,
            Key: {
                id: `${instance.instanceId}-${instance.primaryPublicIpAddress}`
            }
        };
        try {
            let result = await docClient.get(params).promise();
            if (result && result.Item) {
                // convert CustomerGatewayConfiguration raw data (JSON string) into object
                if (result.Item.customerGatewayConfiguration) {
                    result.Item.customerGatewayConfiguration =
                    JSON.parse(result.Item.customerGatewayConfiguration);
                }
            }
            return result && result.Item;
        } catch (error) {
            return null;
        }
    }

    async updateTgwVpnAttachmentRecord(instance, vpnConnection) {
        logger.info('calling updateTgwVpnAttachmentRecord');
        let params = {
            Key: {
                id: `${instance.instanceId}-${instance.primaryPublicIpAddress}`
            },
            TableName: DB.VPNATTACHMENT.TableName
        };

        let parseConfiguration = configuration => {
            return new Promise((resolve, reject) => {
                let xmlParser = new Xml2js.Parser({trim: true});
                xmlParser.parseString(configuration, (err, result) => {
                    if (err) {
                        reject(err);
                    }
                    resolve(result);
                });
            });
        };
        let configuration = await parseConfiguration(vpnConnection.CustomerGatewayConfiguration);
        params.Item = {
            id: `${instance.instanceId}-${instance.primaryPublicIpAddress}`,
            instanceId: instance.instanceId,
            publicIp: instance.primaryPublicIpAddress,
            transitGatewayId: vpnConnection.TransitGatewayId,
            customerGatewayId: vpnConnection.CustomerGatewayId,
            vpnConnectionId: vpnConnection.VpnConnectionId,
            customerGatewayConfiguration: JSON.stringify(configuration)
        };
        params.ConditionExpression = 'attribute_not_exists(id)';
        let result = await docClient.put(params).promise();
        logger.info('called updateTgwVpnAttachmentRecord');
        return result;
    }

    async deleteTgwVpnAttachmentRecord(instance) {
        logger.info('calling deleteTgwVpnAttachmentRecord');
        let params = {
            TableName: DB.VPNATTACHMENT.TableName,
            Key: {
                id: `${instance.instanceId}-${instance.primaryPublicIpAddress}`
            }
        };
        try {
            let result = await docClient.delete(params).promise();
            logger.info('called deleteTgwVpnAttachmentRecord');
            return result;
        } catch (error) {
            logger.error(`called deleteTgwVpnAttachmentRecord > error: ${JSON.stringify(error)}`);
            return error;
        }
    }

    /* eslint-disable max-len */
    /**
     * Get information about a VPC by the given parameters.
     * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html#describeVpcs-property
     * @param {Object} parameters parameters accepts: vpcId
     */
    /* eslint-enable max-len */
    async describeVpc(parameters) {
        logger.info('calling describeVpc');
        if (parameters && parameters.vpcId) {
            let params = {
                VpcIds: [parameters.vpcId]
            };
            const result = await ec2.describeVpcs(params).promise();
            if (result && result.Vpcs && result.Vpcs.length > 0) {
                logger.info('called describeVpc, result: ' +
                    `${result ? JSON.stringify(result) : 'null'}`);
                return result.Vpcs[0];
            }
        }
        logger.warn(`called describeVpc, vpc (id: ${parameters.vpcId}) not found.`);
    }

    /* eslint-disable max-len */
    /**
     * Get information about a Subnet by the given parameters.
     * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html#describeSubnets-property
     * @param {Object} parameters parameters accepts: vpcId,
     * subnetId (a single subnet id),subnetIds(an array of subnetId)
     */
    /* eslint-enable max-len */
    async describeSubnet(parameters) {
        logger.info('calling describeSubnet');
        let params = {};
        if (parameters && parameters.vpcId) {
            params.Filters = [{
                Name: 'vpc-id',
                Values: [parameters.vpcId]
            }];
        }
        if (parameters && parameters.subnetIds && Array.isArray(parameters.subnetIds)) {
            params.SubnetIds = parameters.subnetIds;
        }
        if (parameters && parameters.subnetId) {
            if (!Array.isArray(params.SubnetIds)) {
                params.SubnetIds = [];
            }
            if (!params.SubnetIds.includes(params.subnetId)) {
                params.SubnetIds.push(parameters.subnetId);
            }
        }
        const result = await ec2.describeSubnets(params).promise();
        if (result && result.Subnets && result.Subnets.length > 0) {
            logger.info('called describeSubnet, result: ' +
                `${result ? JSON.stringify(result) : 'null'}`);
            return parameters.subnetId ? result.Subnets[0] : result.Subnets;
        } else {
            logger.warn('called describeSubnet, subnet not found. ' +
            `params: ${JSON.stringify(parameters)}`);
        }
    }

    // end of awsPlatform class
}

class AwsAutoscaleHandler extends AutoScaleCore.AutoscaleHandler {
    constructor() {
        super(new AwsPlatform(), '');
        this._step = '';
        this._selfInstance = null;
        this._masterRecord = null;
        this.setScalingGroup(process.env.AUTO_SCALING_GROUP_NAME,
            process.env.AUTO_SCALING_GROUP_NAME);
    }

    async init() {
        const success = await this.platform.init();
        // retrieve base config from an S3 bucket
        this._baseConfig = await this.getBaseConfig();
        return success;
    }

    /* eslint-disable max-len */
    /**
     * Proxy the response to AWS API Gateway call
     * @param {Number} statusCode status code for the HTTP resonse
     * @param {String | Object} res the response body
     * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
     * @return {Object} the response to AWS API Gateway call
     */
    /* eslint-enable max-len */
    proxyResponse(statusCode, res) {
        let log = logger.log(`(${statusCode}) response body:`, JSON.stringify(res)).flush();
        if (process.env.DEBUG_SAVE_CUSTOM_LOG && (!process.env.DEBUG_SAVE_CUSTOM_LOG_ON_ERROR ||
                process.env.DEBUG_SAVE_CUSTOM_LOG_ON_ERROR &&
                logger.errorCount > 0) && log !== '') {
            this.platform.saveLogToDb(log);
        }
        const response = {
            statusCode,
            headers: {},
            body: typeof res === 'string' ? res : JSON.stringify(res),
            isBase64Encoded: false
        };
        return response;
    }

    /* eslint-disable max-len */
    /**
     *
     * @param {AWS.ProxyIntegrationEvent} event Event from the api-gateway.
     * @param {*} context the runtime context of this function call from AWS Lambda service
     * @param {*} callback the callback url from AWS Lambda service
     * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
     */
    /* eslint-enable max-len */
    async handle(event, context, callback) {
        this._step = 'initializing';
        let proxyMethod = 'httpMethod' in event && event.httpMethod,
            result;
        try {
            const platformInitSuccess = await this.init();
            // return 500 error if script cannot finish the initialization.
            if (!platformInitSuccess) {
                result = 'fatal error, cannot initialize.';
                logger.error(result);
                callback(null, this.proxyResponse(500, result));
            } else if (event.source === 'aws.autoscaling') {
                this._step = 'aws.autoscaling';
                result = await this.handleAutoScalingEvent(event);
                callback(null, this.proxyResponse(200, result));
            } else {
                // authenticate the calling instance
                this.parseRequestInfo(event);
                if (!this._requestInfo.instanceId) {
                    callback(null, this.proxyResponse(403, 'Instance id not provided.'));
                    return;
                }
                await this.parseInstanceInfo(this._requestInfo.instanceId);
                if (proxyMethod === 'POST') {
                    this._step = 'fortigate:handleSyncedCallback';
                    // handle status messages
                    if (this._requestInfo.status) {
                        result = await this.handleStatusMessage(event);
                    } else {
                        result = await this.handleSyncedCallback();
                    }
                    callback(null, this.proxyResponse(200, result));
                } else if (proxyMethod === 'GET') {
                    this._step = 'fortigate:getConfig';
                    result = await this.handleGetConfig();
                    callback(null, this.proxyResponse(200, result));
                } else {
                    this._step = '¯\\_(ツ)_/¯';

                    logger.log(`${this._step} unexpected event!`, event);
                    // probably a test call from the lambda console?
                    // should do nothing in response
                }
            }

        } catch (ex) {
            if (ex.message) {
                ex.message = `${this._step}: ${ex.message}`;
            }
            try {
                console.error('ERROR while ', this._step, proxyMethod, ex);
            } catch (ex2) {
                console.error('ERROR while ', this._step, proxyMethod, ex.message, ex, ex2);
            }
            if (proxyMethod) {
                callback(null,
                    this.proxyResponse(500, {
                        message: ex.message,
                        stack: ex.stack
                    }));
            } else {
                callback(ex);
            }
        }
    }
    async getFazIp() {
        try {
            let keyValue = settingItems.FortiAnalyzerSettingItem.SETTING_KEY;
            const query = {
                    TableName: DB.SETTINGS.TableName,
                    KeyConditionExpression: '#SettingKey = :SettingKey',
                    ExpressionAttributeNames: {
                        '#SettingKey': 'settingKey'
                    },
                    ExpressionAttributeValues: {
                        ':SettingKey': keyValue
                    }
                },
                response = await docClient.query(query).promise();
            if (response.Items && Array.isArray(response.Items) && response.Items.length === 1) {
                let settingItem = settingItems.FortiAnalyzerSettingItem.fromDb(response.Items[0]);
                return settingItem.vip;
            } else {
                return null;
            }
        } catch (error) {
            return null;
        }

    }

    /* ==== Sub-Handlers ==== */

    /* eslint-disable max-len */
    /**
     * Store the lifecycle transition event details for use later.
     * @param {AWS.Event} event Event who's source is 'aws.autoscaling'.
     * @see https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/EventTypes.html#auto_scaling_event_types
     */
    /* eslint-enable max-len */
    async handleAutoScalingEvent(event) {
        logger.info(`calling handleAutoScalingEvent: ${event['detail-type']}`);
        let result, errorTasks = [], tasks = [];
        switch (event['detail-type']) {
            case 'EC2 Instance-launch Lifecycle Action':
                if (event.detail.LifecycleTransition === 'autoscaling:EC2_INSTANCE_LAUNCHING') {
                    await this.platform.cleanUpDbLifeCycleActions();
                    result = await this.handleLaunchingInstanceHook(event);
                }
                break;
            case 'EC2 Instance-terminate Lifecycle Action':
                if (event.detail.LifecycleTransition === 'autoscaling:EC2_INSTANCE_TERMINATING') {

                    await this.platform.cleanUpDbLifeCycleActions();
                    result = await this.handleTerminatingInstanceHook(event);
                }
                break;
            case 'EC2 Instance Launch Successful':
                result = true;
                break;
            case 'EC2 Instance Terminate Successful':
                // remove master record if this instance is the elected master
                this._selfInstance = this._selfInstance ||
                    await this.platform.describeInstance({
                        instanceId: event.detail.EC2InstanceId
                    });
                this._masterRecord = this._masterRecord || await this.platform.getMasterRecord();
                if (this._masterRecord &&
                    this._masterRecord.instanceId === event.detail.EC2InstanceId) {
                    await this.platform.removeMasterRecord();
                }
                // detach nic2
                if (this._selfInstance && ENABLE_SECOND_NIC) {
                    tasks.push(this.handleNicDetachment(event).catch(() => {
                        errorTasks.push('handleNicDetachment');
                    }));
                }
                await Promise.all(tasks);
                result = errorTasks.length === 0 && !!this._selfInstance;
                // remove monitor record
                await this.removeInstanceFromMonitor(event.detail.EC2InstanceId);
                break;
            default:
                logger.warn(`Ignore autoscaling event type: ${event['detail-type']}`);
                result = true;
                break;
        }
        return result;
    }

    async completeGetConfigLifecycleAction(instanceId, success) {
        logger.info('calling completeGetConfigLifecycleAction');
        let items = await this.platform.getLifecycleItems(instanceId);
        items = items.filter(item => {
            return item.actionName === AutoScaleCore.LifecycleItem.ACTION_NAME_GET_CONFIG;
        });
        if (Array.isArray(items) && items.length === 1 && !items[0].done) {
            items[0].done = true;
            let complete = await this.platform.completeLifecycleAction(items[0], success);
            logger.info(`called completeGetConfigLifecycleAction. complete: ${complete}`);
            return items[0];
        } else {
            return items && items[0];
        }
    }

    async handleLaunchingInstanceHook(event) {
        logger.info('calling handleLaunchingInstanceHook');
        const instanceId = event.detail.EC2InstanceId;
        let lifecycleItem, result, errorTasks = [], tasks = [];
        this._selfInstance = this._selfInstance ||
                    await this.platform.describeInstance({
                        instanceId: event.detail.EC2InstanceId
                    });
        this.setScalingGroup(process.env.MASTER_SCALING_GROUP_NAME,
                    event.detail.AutoScalingGroupName);
        // attach nic2
        if (this._selfInstance && ENABLE_SECOND_NIC) {
            tasks.push(this.handleNicAttachment(event).catch(() => {
                errorTasks.push('handleNicAttachment');
            }));
        }
        // handle TGW VPN attachment
        if (this._selfInstance && ENABLE_TGW_VPN) {
            tasks.push(this.handleTgwVpnAttachment(event).catch(() => {
                errorTasks.push('handleTgwVpnAttachment');
            }));
        }
        await Promise.all(tasks);
        result = errorTasks.length === 0 && !!this._selfInstance;
        if (result) {
            // TODO: if any additional process here failed, should turn this lifecycle hook into
            // the abandon state then proceed to clean this instance and related components

            // create a pending lifecycle item for this instance
            lifecycleItem = new AutoScaleCore.LifecycleItem(instanceId, event.detail,
                AutoScaleCore.LifecycleItem.ACTION_NAME_GET_CONFIG, false);
            result = await this.platform.updateLifecycleItem(lifecycleItem);
            logger.info(`ForgiGate (instance id: ${instanceId}) is launching to get config, ` +
                `lifecyclehook(${event.detail.LifecycleActionToken})`);
        }
        return result;
    }

    async handleTerminatingInstanceHook(event) {
        logger.info('calling handleTerminatingInstanceHook');
        let result, errorTasks = [], tasks = [], instanceId = event.detail.EC2InstanceId;
        this._selfInstance = this._selfInstance ||
                    await this.platform.describeInstance({
                        instanceId: event.detail.EC2InstanceId
                    });
        this.setScalingGroup(process.env.MASTER_SCALING_GROUP_NAME,
                    event.detail.AutoScalingGroupName);
        // detach nic2
        if (this._selfInstance && ENABLE_SECOND_NIC) {
            tasks.push(this.handleNicDetachment(event).catch(() => {
                errorTasks.push('handleNicDetachment');
            }));
        }
        // handle TGW VPN attachment
        if (this._selfInstance && ENABLE_TGW_VPN) {
            tasks.push(this.handleTgwVpnDetachment(event).catch(() => {
                errorTasks.push('handleTgwVpnDetachment');
            }));
        }
        await Promise.all(tasks);
        result = errorTasks.length === 0 && !!this._selfInstance;
        if (this._selfInstance && result) {
            // force updating this instance sync state to 'out-of-sync' so the script can treat
            // it as an unhealthy instance
            this._selfHealthCheck = this._selfHealthCheck ||
                await this.platform.getInstanceHealthCheck({
                    instanceId: this._selfInstance.instanceId
                }, 0);
            if (this._selfHealthCheck && this._selfHealthCheck.inSync) {
                await this.platform.updateInstanceHealthCheck(this._selfHealthCheck,
                    AutoScaleCore.AutoscaleHandler.NO_HEART_BEAT_INTERVAL_SPECIFIED,
                    this._selfHealthCheck.masterIp, Date.now(), true);
            }
            // check if master
            let masterInfo = await this.getMasterInfo();
            logger.log(`masterInfo: ${JSON.stringify(masterInfo)}`);
            if (masterInfo && masterInfo.instanceId === this._selfInstance.instanceId) {
                // remove master record so it will trigger a new master election
                let masterRecord = await this.platform.getMasterRecord();
                if (masterRecord) {
                    await this.platform.removeMasterRecord();
                }
            }
            // complete its lifecycle
            let lifecycleItem = new AutoScaleCore.LifecycleItem(instanceId, event.detail,
                AutoScaleCore.LifecycleItem.ACTION_NAME_TERMINATING_INSTANCE, false);
            logger.log(`lifecycle item: ${JSON.stringify(lifecycleItem)}`);
            await this.platform.completeLifecycleAction(lifecycleItem, true);
            await this.platform.cleanUpDbLifeCycleActions([lifecycleItem]);
            logger.info(`ForgiGate (instance id: ${instanceId}) is terminating, lifecyclehook(${
                event.detail.LifecycleActionToken})`);
        } else {
            logger.warn(`cannot handle nic detachment for instance (id: ${instanceId})`);
        }
        return result;
    }

    /** @override */
    async addInstanceToMonitor(instance, heartBeatInterval, masterIp = 'null') {
        logger.info('calling addInstanceToMonitor');
        var params = {
            Item: {
                instanceId: instance.instanceId,
                ip: instance.primaryPrivateIpAddress,
                autoScalingGroupName: this.masterScalingGroupName,
                nextHeartBeatTime: Date.now() + heartBeatInterval * 1000,
                heartBeatLossCount: 0,
                heartBeatInterval: heartBeatInterval,
                syncState: 'in-sync',
                masterIp: masterIp
            },
            TableName: DB.AUTOSCALE.TableName
        };
        return await docClient.put(params).promise();
    }

    async deregisterMasterInstance(instance) {
        logger.info('calling deregisterMasterInstance', JSON.stringify(instance));
        return await this.purgeMaster();
    }

    /* eslint-disable max-len */
    /**
     * Handle the 'getConfig' callback from the FortiGate.
     * @param {Aws.ProxyIntegrationEvent} event Event from the api-gateway.
     * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format // eslint-disable-line max-len
     */
    /* eslint-enable max-len */
    async handleGetConfig() {
        logger.info('calling handleGetConfig');
        let
            config,
            masterInfo,
            params = {},
            instanceId = this._requestInfo.instanceId;

        // get instance object from platform
        this._selfInstance = this._selfInstance ||
            await this.platform.describeInstance({
                instanceId: instanceId,
                scalingGroupName: this.scalingGroupName
            });
        if (!this._selfInstance || this._selfInstance.virtualNetworkId !== process.env.VPC_ID) {
            // not trusted
            throw new Error(`Unauthorized calling instance (instanceId: ${instanceId}).` +
                'Instance not found in VPC.');
        }

        let promiseEmitter = this.checkMasterElection.bind(this),
            validator = result => {
                // if i am the master, don't wait, continue, if not, wait
                if (result &&
                    result.primaryPrivateIpAddress === this._selfInstance.primaryPrivateIpAddress) {
                    return true;
                } else if (this._masterRecord && this._masterRecord.voteState === 'pending') {
                    // master election not done, wait for a moment
                    // clear the current master record cache and get a new one in the next call
                    this._masterRecord = null;
                } else if (this._masterRecord && this._masterRecord.voteState === 'done') {
                    // master election done
                    return true;
                }
                return false;
            },
            counter = () => {
                if (Date.now() < process.env.SCRIPT_EXECUTION_EXPIRE_TIME - 3000) {
                    return false;
                }
                logger.warn('script execution is about to expire');
                return true;
            };

        try {
            masterInfo = await AutoScaleCore.waitFor(promiseEmitter, validator, 5000, counter);
        } catch (error) {
            // if error occurs, check who is holding a master election, if it is this instance,
            // terminates this election. then tear down this instance whether it's master or not.
            this._masterRecord = this._masterRecord || await this.platform.getMasterRecord();
            if (this._masterRecord.instanceId === this._selfInstance.instanceId &&
                this._masterRecord.asgName === this._selfInstance.scalingGroupName) {
                await this.platform.removeMasterRecord();
            }
            await this.removeInstance(this._selfInstance);
            throw new Error('Failed to determine the master instance. This instance is unable' +
                ' to bootstrap. Please report this to' +
                ' administrators.');
        }

        // get TGW_VPN record
        if (ENABLE_TGW_VPN) {
            let vpnAttachmentRecord =
                await this.platform.getTgwVpnAttachmentRecord(this._selfInstance);
            if (vpnAttachmentRecord) {
                params.vpnConfigSetName = 'setuptgwvpn';
                params.vpnConfiguration =
                vpnAttachmentRecord.customerGatewayConfiguration.vpn_connection;
            }
        }

        // the master ip same as mine? (diagram: master IP same as mine?)
        if (masterInfo.primaryPrivateIpAddress === this._selfInstance.primaryPrivateIpAddress) {
            this._step = 'handler:getConfig:getMasterConfig';
            params.callbackUrl = await this.platform.getCallbackEndpointUrl();
            config = await this.getMasterConfig(params);
            logger.info('called handleGetConfig: returning master config' +
                `(master-ip: ${masterInfo.primaryPrivateIpAddress}):\n ${config}`);
            return config;
        } else {

            this._step = 'handler:getConfig:getSlaveConfig';
            params.callbackUrl = await this.platform.getCallbackEndpointUrl();
            params.masterIp = masterInfo.primaryPrivateIpAddress;
            config = await this.getSlaveConfig(params);
            logger.info('called handleGetConfig: returning slave config' +
                `(master-ip: ${masterInfo.primaryPrivateIpAddress}):\n ${config}`);
            return config;
        }
    }

    /* ==== Utilities ==== */

    async handleNicAttachment(event) {
        logger.info('calling handleNicAttachment');
        if (!event || !event.detail || !event.detail.EC2InstanceId) {
            logger.warn(`event not contains ec2 instance info. event: ${JSON.stringify(event)}`);
            return null;
        }
        try {
            let params, result, nic;
            this._selfInstance = this._selfInstance ||
                await this.platform.describeInstance({
                    instanceId: event.detail.EC2InstanceId
                });
            // create a nic
            let description = `Addtional nic for instance(id:${this._selfInstance.instanceId}) ` +
                `in auto scaling group: ${this.scalingGroupName}`;
            let securityGroups = [];
            this._selfInstance.securityGroups.forEach(sgItem => {
                securityGroups.push(sgItem.GroupId);
            });
            let attachmentRecord =
                await this.platform.getNicAttachmentRecord(this._selfInstance.instanceId),
                subnetPairs = await this.loadSubnetPairs();
            let subnetId = this._selfInstance.subnetId; // set subnet by default
            // find a paired subnet Id if there is one.
            if (Array.isArray(subnetPairs) && subnetPairs.length > 0) {
                let subnetPair = subnetPairs.filter(element => {
                    return element.subnetId === subnetId;
                });
                if (subnetPair && subnetPair.length >= 0 && subnetPair[0].pairId) {
                    subnetId = subnetPair[0].pairId;
                }
            }
            if (!attachmentRecord) {
                params = {
                    Description: description,
                    Groups: securityGroups,
                    SubnetId: subnetId
                };
                nic = await this.platform.createNetworkInterface(params);
                if (!nic) {
                    throw new Error('create network interface unsuccessfully.');
                }
                await this.platform.updateNicAttachmentRecord(this._selfInstance.instanceId,
                    nic.NetworkInterfaceId, 'pending_attach');
                result = await this.platform.attachNetworkInterface(this._selfInstance, nic);
                if (!result) {
                    params = {
                        NetworkInterfaceId: nic.NetworkInterfaceId
                    };
                    await this.platform.deleteNetworkInterface(params);
                    throw new Error('attach network interface unsuccessfully.');
                }
                await this.platform.updateNicAttachmentRecord(this._selfInstance.instanceId,
                    nic.NetworkInterfaceId, 'attached', 'pending_attach');
                // reload the instance info
                this._selfInstance =
                    await this.platform.describeInstance({
                        instanceId: event.detail.EC2InstanceId
                    });
                return true;
            } else {
                logger.info(`instance (id: ${attachmentRecord.instanceId}) has been in ` +
                    `association with nic (id: ${attachmentRecord.nicId}) ` +
                    `in state (${attachmentRecord.attachmentState})`);
                return true;
            }
        } catch (error) {
            logger.warn(`called handleNicAttachment with error: ${JSON.stringify(error)}`);
            return null;
        }
    }

    async handleNicDetachment(event) {
        logger.info('calling handleNicDetachment');
        let attachmentRecord, nic;
        if (!event || !event.detail || !event.detail.EC2InstanceId) {
            logger.warn(`event not contains ec2 instance info. event: ${JSON.stringify(event)}`);
            return null;
        }
        try {
            this._selfInstance = this._selfInstance ||
                await this.platform.describeInstance({
                    instanceId: event.detail.EC2InstanceId
                });
            attachmentRecord =
                await this.platform.getNicAttachmentRecord(this._selfInstance.instanceId);
            if (attachmentRecord && attachmentRecord.attachmentState === 'attached') {
                // get nic
                nic = await this.platform.describeNetworkInterface({
                    NetworkInterfaceIds: [
                        attachmentRecord.nicId
                    ]
                });
                // updete attachment record for in transition
                await this.platform.updateNicAttachmentRecord(attachmentRecord.instanceId,
                    attachmentRecord.nicId, 'pending_detach', 'attached');
                // detach nic
                await this.platform.detachNetworkInterface(this._selfInstance, nic);
                // delete nic
                await this.platform.deleteNetworkInterface({
                    NetworkInterfaceId: attachmentRecord.nicId
                });
                // delete attachment record
                await this.platform.deleteNicAttachmentRecord(
                    attachmentRecord.instanceId, 'pending_detach');
                // reload the instance info
                this._selfInstance =
                    await this.platform.describeInstance({
                        instanceId: event.detail.EC2InstanceId
                    });
            } else if (!attachmentRecord) {
                logger.info('no tracking record of network interface attached to instance ' +
                    `(id: ${this._selfInstance.instanceId})`);
            } else {
                logger.info(`instance (id: ${attachmentRecord.instanceId}) with nic ` +
                    `(id: ${attachmentRecord.nicId}) is not in in the 'attached' state ` +
                    `(${attachmentRecord.attachmentState})`);
            }
            return true;
        } catch (error) {
            // rollback attachment record to attached state
            if (attachmentRecord) {
                // reload nic info
                nic = await this.platform.describeNetworkInterface({
                    NetworkInterfaceIds: [
                        attachmentRecord.nicId
                    ]
                });
                // if nic is still attached to the same instance
                if (nic && nic.Attachment &&
                    nic.Attachment.InstanceId === attachmentRecord.instanceId) {
                    await this.platform.updateNicAttachmentRecord(attachmentRecord.instanceId,
                        attachmentRecord.nicId, 'attached', 'pending_detach');
                }
            }
            logger.warn(`called handleNicDetachment with error: ${JSON.stringify(error)}`);
            return null;
        }
    }

    async updateCapacity(desiredCapacity, minSize, maxSize) {
        logger.info('calling updateCapacity');
        let params = {
            AutoScalingGroupName: this.scalingGroupName
        };
        if (desiredCapacity !== null && !isNaN(desiredCapacity)) {
            params.DesiredCapacity = parseInt(desiredCapacity);
        }
        if (minSize !== null && !isNaN(minSize)) {
            params.MinSize = parseInt(minSize);
        }
        if (maxSize !== null && !isNaN(maxSize)) {
            params.MaxSize = parseInt(maxSize);
        }
        try {
            let result = await autoScaling.updateAutoScalingGroup(params).promise();
            logger.info('called updateCapacity. done.', result);
            return true;
        } catch (error) {
            logger.warn('called updateCapacity. failed.', error);
            return false;
        }
    }

    async checkAutoScalingGroupState() {
        try {
            logger.info('calling checkAutoScalingGroupState');
            let state = 'in-service',
                noScale = false,
                instanceInService = false,
                instanceTerminated = false,
                instanceStateInTransition = false,
                noInstance = false,
                noNic = false;
            let groupCheck = await this.platform.describeAutoScalingGroups(
                this.scalingGroupName
            );
            if (!groupCheck) {
                throw new Error(`auto scaling group (${this.scalingGroupName})` +
                    'does not exist.');
            }
            // check if capacity set to (desired:0, minSize: 0, maxSize: any number)
            if (groupCheck.DesiredCapacity === 0 && groupCheck.MinSize === 0) {
                noScale = true;
            }
            instanceInService = true;
            if (groupCheck.Instances && groupCheck.Instances.length === 0) {
                instanceInService = false;
                noInstance = true;
            }
            groupCheck.Instances.forEach(instance => {
                if (instance.LifecycleState !== 'InService') {
                    instanceInService = false;
                }
                if (instance.LifecycleState === 'Pending' ||
                    instance.LifecycleState === 'Pending:Wait' ||
                    instance.LifecycleState === 'Pending:Proceed' ||
                    instance.LifecycleState === 'Terminating' ||
                    instance.LifecycleState === 'Terminating:Wait' ||
                    instance.LifecycleState === 'Terminating:Proceed' ||
                    instance.LifecycleState === 'Detaching' ||
                    instance.LifecycleState === 'EnteringStandby') {
                    instanceStateInTransition = true;
                }
                if (instance.LifecycleState === 'Terminated') {
                    instanceTerminated = true;
                }
            });
            // check if all additional nics are detached and removed
            let nicAttachmentCheck = await this.platform.listNicAttachmentRecord();
            noNic = !nicAttachmentCheck || nicAttachmentCheck.length === 0;

            // if any instance is in service, the group is in-service
            if (instanceInService) {
                state = 'in-service';
            }
            // if any instance is in transition, the group is in-transition
            if (instanceStateInTransition) {
                state = 'in-transition';
            }
            // if the group is not-scaled and all instances are terminated, the group is stopped
            if (noScale && instanceTerminated) {
                state = 'stopped';
            }
            // this is the fully stopped case
            if (noScale && !instanceInService && noInstance && noNic) {
                state = 'stopped';
            }
            logger.info(`called checkAutoScalingGroupState: state: ${state} `);
            return state;
        } catch (error) {
            logger.error(error);
            return null;
        }
    }

    async cleanUpAdditionalNics() {
        logger.info('calling cleanUpAdditionalNics');
        // list all nics with tag: {key: 'FortiGateAutoscaleNicAttachment', value:
        // RESOURCE_TAG_PREFIX
        let nics = await this.platform.listNetworkInterfaces({
            Filters: [{
                Name: 'tag:FortiGateAutoscaleNicAttachment',
                Values: [RESOURCE_TAG_PREFIX]
            }]
        });
        let tasks = [];
        // delete them
        if (Array.isArray(nics) && nics.length > 0) {
            nics.forEach(element => {
                tasks.push(this.platform.deleteNetworkInterface({
                    NetworkInterfaceId: element.NetworkInterfaceId
                }));
            });
            try {
                await Promise.all(tasks);
                logger.info('called cleanUpAdditionalNics. no error.');
                return true;
            } catch (error) {
                logger.error('calling cleanUpAdditionalNics. error > ', error);
                return false;
            }
        }
    }

    /** @override */
    async removeInstance(instance) {
        return await this.platform.terminateInstanceInAutoScalingGroup(instance);
    }

    async parseInstanceInfo(instanceId) {
        // look for this vm in both byol and payg vmss
        // look from byol first
        this._selfInstance = this._selfInstance || await this.platform.describeInstance({
            instanceId: instanceId,
            scalingGroupName: process.env.SCALING_GROUP_NAME_BYOL
        });
        if (this._selfInstance) {
            this.setScalingGroup(
                process.env.MASTER_SCALING_GROUP_NAME,
                process.env.SCALING_GROUP_NAME_BYOL
            );
        } else { // not found in byol vmss, look from payg
            this._selfInstance = await this.platform.describeInstance({
                instanceId: instanceId,
                scalingGroupName: process.env.SCALING_GROUP_NAME_PAYG
            });
            if (this._selfInstance) {
                this.setScalingGroup(
                    process.env.MASTER_SCALING_GROUP_NAME,
                    process.env.SCALING_GROUP_NAME_PAYG
                );
            }
        }
        if (this._selfInstance) {
            logger.info(`instance identification (id: ${this._selfInstance.instanceId}, ` +
                `scaling group self: ${this.scalingGroupName}, ` +
                `master: ${this.masterScalingGroupName})`);
        } else {
            logger.warn(`cannot identify instance: vmid:(${instanceId})`);
        }
    }

    async handleTgwVpnAttachment(event) {
        logger.info('calling handleTgwVpnAttachment');
        if (!event || !event.detail || !event.detail.EC2InstanceId) {
            logger.warn(`event not contains ec2 instance info. event: ${JSON.stringify(event)}`);
            return null;
        }
        try {
            this._selfInstance = this._selfInstance ||
                await this.platform.describeInstance({
                    instanceId: event.detail.EC2InstanceId
                });
            // create an ec2 vpn of "ipsec.1" type
            // get the transit gateway id
            let transitGatewayId = process.env.TGW_ID;
            let attachmentRecord =
                await this.platform.getTgwVpnAttachmentRecord(this._selfInstance);
            if (attachmentRecord) {
                logger.warn('Transit Gateway VPN attachment for instance id: ' +
                `(${this._selfInstance.instanceId}) already exisits.`);
                return true;
            }
            // create a customer gateway with the public IP address of the FGT instance
            // try to get a setting of customer gateway
            let bgpAsn = await this.platform.getSettingItem('customer-gateway.bgpasn');
            // take 65000 by AWS' default
            bgpAsn = bgpAsn && bgpAsn.value && !isNaN(bgpAsn.value) ? bgpAsn.value : 65000;
            let customerGateway = await this.platform.createCustomerGateway({
                bgpAsn: bgpAsn,
                publicIp: this._selfInstance.primaryPublicIpAddress,
                type: 'ipsec.1'
            });
            // create the vpn connection
            let vpnConnection =
                await this.platform.createVpnConnection({
                    customerGatewayId: customerGateway.CustomerGatewayId,
                    transitGatewayId: transitGatewayId,
                    type: 'ipsec.1',
                    publicIp: this._selfInstance.primaryPublicIpAddress
                });
            // save attachment record
            if (!vpnConnection) {
                throw new Error('create VPN connection unsuccessfully.');
            }

            await this.platform.updateTgwVpnAttachmentRecord(this._selfInstance, vpnConnection);
            logger.info('Transit Gateway VPN attachment (' +
            `vpn id: ${vpnConnection.VpnConnectionId}, ` +
            `tgw id: ${vpnConnection.TransitGatewayId}) created.`);
            return true;
        } catch (error) {
            logger.warn(`called handleTgwVpnAttachment with error: ${JSON.stringify(error)}`);
            return null;
        }
    }

    async handleTgwVpnDetachment(event) {
        logger.info('calling handleTgwVpnDetachment');
        let attachmentRecord;
        if (!event || !event.detail || !event.detail.EC2InstanceId) {
            logger.warn(`event not contains ec2 instance info. event: ${JSON.stringify(event)}`);
            return null;
        }
        try {
            this._selfInstance = this._selfInstance ||
                await this.platform.describeInstance({
                    instanceId: event.detail.EC2InstanceId
                });
            attachmentRecord =
                await this.platform.getTgwVpnAttachmentRecord(this._selfInstance);
            if (attachmentRecord) {
                // delete vpn
                await this.platform.deleteVpnConnection({
                    vpnConnectionId: attachmentRecord.vpnConnectionId
                });
                // delete customer gateway
                await this.platform.deleteCustomerGateway({
                    customerGatewayId: attachmentRecord.customerGatewayId
                });
                // delete attachment record
                await this.platform.deleteTgwVpnAttachmentRecord(this._selfInstance);
                logger.info('Transit Gateway VPN attachment (' +
                `vpn id: ${attachmentRecord.vpnConnectionId}, ` +
                `tgw id: ${attachmentRecord.transitGatewayId}) deleted.`);
            } else {
                logger.info('Transit Gateway VPN attachment for instance (' +
                `id: ${this._selfInstance.instanceId}` +
                `public ip: ${this._selfInstance.primaryPublicIpAddress}) not found.`);
            }
            return true;
        } catch (error) {
            logger.warn(`called handleTgwVpnDetachment with error: ${JSON.stringify(error)}`);
            return null;
        }
    }

    /** @override */
    async parseVpnConfiguration(config, vpnConfiguration) {
        let fortigate = {};
        let resourceMap = {
            vpnConfiguration: vpnConfiguration
        };
        let nodePath, conf = config, match,
            matches = typeof config === 'string' ? config.match(/({\S+})/gm) : [];
        try {
            for (nodePath of matches) {
                let data = null, resource = null, replaceBy = null,
                    resRoot = typeof nodePath === 'string' ? nodePath.split('.')[0].substr(1) : '';
                switch (resRoot) {
                    case '@vpc':
                        if (!resourceMap[resRoot]) {
                            data = await this.platform.describeVpc({
                                vpcId: this._selfInstance.virtualNetworkId
                            });
                            resourceMap['@vpc'] = data;
                            data = await this.platform.describeSubnet({
                                vpcId: this._selfInstance.virtualNetworkId
                            });
                            if (data && Array.isArray(data)) {
                                resourceMap['@vpc'].subnet = data;
                            }
                        }
                        resource = resourceMap; // here pass the the upper level object where it's
                        // slightly deferent from the default case.
                        replaceBy =
                            AutoScaleCore.Functions.configSetResourceFinder(resource, nodePath);
                        break;
                    case '@fortigate':
                        // will fetch info from db that input by user when deploy the template
                        match = /{@(.+)}/g.exec(nodePath);
                        if (match && match[1] && !resourceMap[match[1]]) {
                            match = match[1];
                            data = await this.platform.getSettingItem(match.replace(/\./g, '-'));
                            resourceMap[match] = data || null;
                        }
                        replaceBy = resourceMap[match];
                        break;
                    default:
                        resource = resourceMap.vpnConfiguration;
                        replaceBy =
                            AutoScaleCore.Functions.configSetResourceFinder(resource, nodePath);
                        break;
                }
                if (replaceBy) {
                    conf = conf.replace(new RegExp(nodePath, 'g'), replaceBy);
                }
            }
        } catch (error) {
            console.log(error);
        }
        return conf;
    }
    async cleanUpTgwVpns() {
        logger.info('calling cleanUpTgwVpns');
        // list all nics with tag: {key: 'FortiGateAutoscaleNicAttachment', value:
        // RESOURCE_TAG_PREFIX
        let nics = await this.platform.listNetworkInterfaces({
            Filters: [{
                Name: 'tag:FortiGateAutoscaleNicAttachment',
                Values: [RESOURCE_TAG_PREFIX]
            }]
        });
        let tasks = [];
        // delete them
        if (Array.isArray(nics) && nics.length > 0) {
            nics.forEach(element => {
                tasks.push(this.platform.deleteNetworkInterface({
                    NetworkInterfaceId: element.NetworkInterfaceId
                }));
            });
            try {
                await Promise.all(tasks);
                logger.info('called cleanUpTgwVpns. no error.');
                return true;
            } catch (error) {
                logger.error('calling cleanUpTgwVpns. error > ', error);
                return false;
            }
        }
    }
    // end of AwsAutoscaleHandler class

}

/**
 * Initialize the module to be able to run via the 'handle' function.
 * Otherwise, this module only exposes some classes.
 * @returns {Object} exports
 */
function initModule() {
    process.env.SCRIPT_EXECUTION_TIME_CHECKPOINT = Date.now();
    AWS.config.update({
        region: process.env.AWS_REGION
    });

    exports.logger = logger;

    return exports;
}

/**
 * Handle the auto scaling
 * @param {Object} event The event been passed to
 * @param {Object} context The Lambda function runtime context
 * @param {Function} callback a callback function been triggered by AWS Lambda mechanism
 */
exports.handler = async (event, context, callback) => {
    process.env.SCRIPT_EXECUTION_EXPIRE_TIME = Date.now() + context.getRemainingTimeInMillis();
    logger = new AutoScaleCore.DefaultLogger(console);
    const handler = new AwsAutoscaleHandler();
    if (process.env.DEBUG_LOGGER_OUTPUT_QUEUE_ENABLED &&
        process.env.DEBUG_LOGGER_OUTPUT_QUEUE_ENABLED.toLowerCase() === 'true') {
        logger.outputQueue = true;
        if (process.env.DEBUG_LOGGER_TIMEZONE_OFFSET) {
            logger.timeZoneOffset = process.env.DEBUG_LOGGER_TIMEZONE_OFFSET;
        }
    }
    handler.useLogger(logger);
    initModule();
    await handler.handle(event, context, callback);
};

/**
 * expose the module runtime id
 * @returns {String} a unique id.
 */
exports.moduleRuntimeId = () => moduleId;
exports.initModule = initModule;
exports.AutoScaleCore = AutoScaleCore; // get a reference to the core
exports.AwsPlatform = AwsPlatform;
exports.AwsAutoscaleHandler = AwsAutoscaleHandler;
exports.settingItems = settingItems;
exports.logger = logger;
