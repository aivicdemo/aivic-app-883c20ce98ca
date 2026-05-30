import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, hasPermission, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'MainTable';

interface TableConfig {
  name: string;
  pkField: string;
  requiredFields: string[];
}

const tableConfigs: { [key: string]: TableConfig } = {
  '0': { name: 'NotificationSettings', pkField: 'notificationSettingId', requiredFields: ['userId', 'notificationType', 'notificationMethod', 'activeFlag', 'createdAt', 'updatedAt', 'creatorId'] },
  '1': { name: 'LoginUsers', pkField: 'userId', requiredFields: ['loginId', 'passwordHash', 'userName', 'emailAddress', 'permissionLevel', 'activeFlag', 'createdAt', 'updatedAt', 'creatorId', 'updaterId'] },
  '2': { name: 'Spectators', pkField: 'spectatorId', requiredFields: ['userId', 'spectatorName', 'emailAddress', 'viewingHistoryCount', 'memberRank', 'usageStatus', 'createdAt', 'updatedAt', 'creator', 'updater'] },
  '3': { name: 'SpectatorAttributes', pkField: 'spectatorAttributeId', requiredFields: ['spectatorId', 'pushNotificationDesired', 'emailDeliveryDesired', 'activeFlag', 'createdAt', 'updatedAt', 'creator', 'updater'] },
  '4': { name: 'SpectatorBehaviorHistory', pkField: 'behaviorHistoryId', requiredFields: ['spectatorId', 'behaviorType', 'targetScreen', 'sessionId', 'deviceType', 'ipAddress', 'behaviorDateTime', 'createdAt'] },
  '5': { name: 'DeliveryChannelMaster', pkField: 'channelId', requiredFields: ['channelName', 'channelCode', 'deliveryMethod', 'priority', 'activeFlag', 'immediateDeliveryFlag', 'displayOrder', 'createdAt', 'updatedAt', 'creator', 'updater'] },
  '6': { name: 'ImportantInformationMaster', pkField: 'importantInformationId', requiredFields: ['informationTitle', 'informationContent', 'informationType', 'priority', 'deliveryStartDateTime', 'deliveryStatus', 'emergencyFlag', 'pushNotificationFlag', 'activeFlag', 'creatorId', 'createdAt', 'updatedAt'] },
  '7': { name: 'DeliveryTargetGroup', pkField: 'deliveryTargetGroupId', requiredFields: ['groupName', 'targetConditionType', 'activeFlag', 'creatorId', 'createdAt'] },
  '8': { name: 'DeliveryTargetSettings', pkField: 'deliveryTargetSettingId', requiredFields: ['deliveryTargetGroupId', 'deliveryChannelId', 'deliveryStartDateTime', 'deliveryStatus', 'priority', 'activeFlag', 'createdAt', 'updatedAt', 'creatorId', 'updaterId'] },
  '9': { name: 'DeliveryHistory', pkField: 'deliveryHistoryId', requiredFields: ['deliveryChannelId', 'deliveryTitle', 'deliveryContent', 'deliveryType', 'deliveryStatus', 'deliveryStartDateTime', 'targetCount', 'successCount', 'failureCount', 'successRate', 'delivererId', 'delivererName', 'createdAt', 'updatedAt', 'creator', 'updater'] },
  '10': { name: 'InformationChangeDetectionLog', pkField: 'logId', requiredFields: ['changeTargetTableName', 'changeTargetRecordId', 'changeType', 'importanceLevel', 'deliveryTargetFlag', 'processingStatus', 'detectionDateTime', 'createdAt', 'updatedAt'] },
  '11': { name: 'DeliveryChannelSelectionHistory', pkField: 'selectionHistoryId', requiredFields: ['spectatorId', 'deliveryChannelId', 'selectionOperationType', 'selectionStatus', 'selectionDateTime', 'createdAt', 'creator'] },
  '12': { name: 'DeliveryEffectMeasurement', pkField: 'effectMeasurementId', requiredFields: ['deliveryHistoryId', 'spectatorId', 'deliveryChannelId', 'deliveryDateTime', 'openFlag', 'clickFlag', 'clickCount', 'deviceType', 'deliverySuccessFlag', 'createdAt', 'updatedAt'] }
};

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header missing');
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return {
      id: payload.sub || 'unknown',
      role: payload.role || 'viewer',
      permissions: []
    };
  } catch {
    return { id: 'anonymous', role: 'viewer', permissions: [] };
  }
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
  };
}

function validateRequiredFields(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (item[field] === undefined || item[field] === null || item[field] === '') {
      errors.push(`Required field '${field}' is missing or empty`);
    }
  }
  return errors;
}

async function createAuditLog(action: string, tableName: string, recordId: string, userId: string, details?: any): Promise<void> {
  const auditRecord = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    tableName,
    recordId,
    userId,
    timestamp: new Date().toISOString(),
    details: details || {}
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditRecord
    }));
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = getCurrentUser(event);
    const path = event.path;
    const method = event.httpMethod;
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources - 全テーブルのリソース一覧取得
    if (method === 'GET' && path === '/resources') {
      checkPermission(user, 'resources:read');
      
      const resources: any = {};
      
      for (const [tableIndex, config] of Object.entries(tableConfigs)) {
        try {
          const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'begins_with(pk, :pk)',
            ExpressionAttributeValues: {
              ':pk': config.name
            }
          });
          
          const result = await docClient.send(command);
          resources[config.name] = result.Items || [];
        } catch (error) {
          console.error(`Error scanning ${config.name}:`, error);
          resources[config.name] = [];
        }
      }
      
      return createResponse(200, resources);
    }

    // POST /api/{tableIndex}/bulk - 一括インポート
    const bulkMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (method === 'POST' && bulkMatch) {
      checkPermission(user, 'bulk:import');
      
      const tableIndex = bulkMatch[1];
      const config = tableConfigs[tableIndex];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }
      
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      
      // 25件ずつに分割してバッチ処理
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = [];
        
        for (const item of batch) {
          const validationErrors = validateRequiredFields(item, config.requiredFields);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(...validationErrors);
            continue;
          }
          
          const now = new Date().toISOString();
          const enrichedItem = {
            ...item,
            pk: config.name,
            sk: item[config.pkField] || randomUUID(),
            [config.pkField]: item[config.pkField] || randomUUID(),
            createdAt: item.createdAt || now,
            updatedAt: now
          };
          
          writeRequests.push({
            PutRequest: {
              Item: enrichedItem
            }
          });
        }
        
        if (writeRequests.length > 0) {
          try {
            await docClient.send(new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: writeRequests
              }
            }));
            imported += writeRequests.length;
          } catch (error) {
            failed += writeRequests.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }
      }
      
      await createAuditLog('BULK_IMPORT', config.name, 'multiple', user.id, { imported, failed });
      
      return createResponse(200, { imported, failed, errors });
    }

    // GET /api/{tableIndex} - テーブル一覧取得
    const listMatch = path.match(/^\/api\/(\d+)$/);
    if (method === 'GET' && listMatch) {
      checkPermission(user, 'resources:read');
      
      const tableIndex = listMatch[1];
      const config = tableConfigs[tableIndex];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const command = new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': config.name
        }
      });
      
      const result = await docClient.send(command);
      return createResponse(200, { items: result.Items || [] });
    }

    // GET /api/{tableIndex}/{id} - 詳細取得
    const detailMatch = path.match(/^\/api\/(\d+)\/([^/]+)$/);
    if (method === 'GET' && detailMatch) {
      checkPermission(user, 'resources:read');
      
      const tableIndex = detailMatch[1];
      const id = detailMatch[2];
      const config = tableConfigs[tableIndex];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const command = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.name,
          sk: id
        }
      });
      
      const result = await docClient.send(command);
      
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      return createResponse(200, result.Item);
    }

    // POST /api/{tableIndex} - 新規作成
    const createMatch = path.match(/^\/api\/(\d+)$/);
    if (method === 'POST' && createMatch) {
      checkPermission(user, 'resources:write');
      
      const tableIndex = createMatch[1];
      const config = tableConfigs[tableIndex];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const validationErrors = validateRequiredFields(body, config.requiredFields);
      
      if (validationErrors.length > 0) {
        return createResponse(400, { errors: validationErrors });
      }
      
      const now = new Date().toISOString();
      const id = body[config.pkField] || randomUUID();
      
      const item = {
        ...body,
        pk: config.name,
        sk: id,
        [config.pkField]: id,
        createdAt: now,
        updatedAt: now
      };
      
      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      });
      
      await docClient.send(command);
      await createAuditLog('CREATE', config.name, id, user.id, item);
      
      return createResponse(201, item);
    }

    // PUT /api/{tableIndex}/{id} - 更新
    const updateMatch = path.match(/^\/api\/(\d+)\/([^/]+)$/);
    if (method === 'PUT' && updateMatch) {
      checkPermission(user, 'resources:write');
      
      const tableIndex = updateMatch[1];
      const id = updateMatch[2];
      const config = tableConfigs[tableIndex];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();
      
      const item = {
        ...body,
        pk: config.name,
        sk: id,
        [config.pkField]: id,
        updatedAt: now
      };
      
      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      });
      
      await docClient.send(command);
      await createAuditLog('UPDATE', config.name, id, user.id, item);
      
      return createResponse(200, item);
    }

    // DELETE /api/{tableIndex}/{id} - 削除
    const deleteMatch = path.match(/^\/api\/(\d+)\/([^/]+)$/);
    if (method === 'DELETE' && deleteMatch) {
      checkPermission(user, 'resources:delete');
      
      const tableIndex = deleteMatch[1];
      const id = deleteMatch[2];
      const config = tableConfigs[tableIndex];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const command = new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.name,
          sk: id
        }
      });
      
      await docClient.send(command);
      await createAuditLog('DELETE', config.name, id, user.id);
      
      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error: any) {
    console.error('Handler error:', error);
    
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: error.message });
    }
    
    if (error.message.includes('Authorization header missing')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};