import type { MeshTransform } from '@graphql-mesh/types'
import { delegateToSchema, DelegationContext, SubschemaConfig } from '@graphql-tools/delegate'
import type { ExecutionRequest } from '@graphql-tools/utils'
import {
  ArgumentNode,
  ExecutionResult,
  GraphQLSchema,
  isListType,
  isNonNullType,
  Kind,
  print,
  SelectionNode,
  visit,
} from 'graphql'
import { memoize1, memoize2 } from '@graphql-tools/utils'
import _ from 'lodash'

interface AutoPaginationTransformConfig {
  if?: boolean
  validateSchema?: boolean
  limitOfRecords?: number
  firstArgumentName?: string
  skipArgumentName?: string
  lastIdArgumentName?: string
  skipArgumentLimit?: number
}

const DEFAULTS: Required<AutoPaginationTransformConfig> = {
  if: true,
  validateSchema: true,
  limitOfRecords: 1000,
  firstArgumentName: 'first',
  skipArgumentName: 'skip',
  lastIdArgumentName: 'where.id_gte',
  skipArgumentLimit: 5000,
}

const validateSchema = memoize2(function validateSchema(
  schema: GraphQLSchema,
  config: Required<AutoPaginationTransformConfig>,
): void {
  const queryType = schema.getQueryType()
  if (queryType == null) {
    throw new Error(`Make sure you have a query type in this source before applying Block Tracking`)
  }
  const queryFields = queryType.getFields()
  for (const fieldName in queryFields) {
    if (fieldName.startsWith('_')) {
      continue
    }
    const field = queryFields[fieldName]
    const nullableType = isNonNullType(field.type) ? field.type.ofType : field.type
    if (isListType(nullableType)) {
      if (!field.args.some((arg) => arg.name === config.firstArgumentName)) {
        throw new Error(`Make sure you have a ${config.firstArgumentName} argument in the query field ${fieldName}`)
      }
      if (!field.args.some((arg) => arg.name === config.skipArgumentName)) {
        throw new Error(`Make sure you have a ${config.skipArgumentName} argument in the query field ${fieldName}`)
      }
    }
  }
})

const getQueryFieldNames = memoize1(function getQueryFields(schema: GraphQLSchema) {
  const queryType = schema.getQueryType()
  if (queryType == null) {
    throw new Error(`Make sure you have a query type in this source before applying Block Tracking`)
  }
  return Object.keys(queryType.getFields())
})

export default class AutoPaginationTransform implements MeshTransform {
  public config: Required<AutoPaginationTransformConfig>
  constructor({ config }: { config?: AutoPaginationTransformConfig } = {}) {
    this.config = { ...DEFAULTS, ...config }
    if (this.config.if === false) {
      return {} as AutoPaginationTransform
    }
  }

  transformSchema(
    schema: GraphQLSchema,
    subschemaConfig: SubschemaConfig<any, any, any, any>,
    transformedSchema: GraphQLSchema | undefined,
  ) {
    if (this.config.validateSchema) {
      validateSchema(schema, this.config)
    }
    if (transformedSchema != null) {
      const queryType = transformedSchema.getQueryType()
      if (queryType != null) {
        const queryFields = queryType.getFields()
        for (const fieldName in queryFields) {
          if (!fieldName.startsWith('_')) {
            const field = queryFields[fieldName]
            const existingResolver = field.resolve!
            field.resolve = async (root, args, context, info) => {
              const totalRecords = args[this.config.firstArgumentName] || 1000
              const initialSkipValue = args[this.config.skipArgumentName] || 0
              if (totalRecords >= this.config.skipArgumentLimit * 2) {
                let remainingRecords = totalRecords
                const records: any[] = []
                while (remainingRecords > 0) {
                  let skipValue = records.length === 0 ? initialSkipValue : 0
                  const lastIdValue = records.length > 0 ? records[records.length - 1].id : null
                  while (skipValue < this.config.skipArgumentLimit && remainingRecords > 0) {
                    const newArgs = {
                      ...args,
                    }
                    if (lastIdValue) {
                      _.set(newArgs, this.config.lastIdArgumentName, lastIdValue)
                    }
                    _.set(newArgs, this.config.skipArgumentName, skipValue)
                    const askedRecords = Math.min(remainingRecords, this.config.skipArgumentLimit)
                    _.set(newArgs, this.config.firstArgumentName, askedRecords)
                    const result = await delegateToSchema({
                      schema: transformedSchema,
                      args: newArgs,
                      context,
                      info,
                    })
                    if (!Array.isArray(result)) {
                      return result
                    }
                    records.push(...result)
                    skipValue += askedRecords
                    remainingRecords -= askedRecords
                  }
                }
                return records
              }
              return existingResolver(root, args, context, info)
            }
          }
        }
      }
    }
    return schema
  }

  transformRequest(executionRequest: ExecutionRequest, delegationContext: DelegationContext): ExecutionRequest {
    const document = visit(executionRequest.document, {
      SelectionSet: {
        leave: (selectionSet) => {
          const newSelections: SelectionNode[] = []
          for (const selectionNode of selectionSet.selections) {
            if (
              selectionNode.kind === Kind.FIELD &&
              !selectionNode.name.value.startsWith('_') &&
              getQueryFieldNames(delegationContext.transformedSchema).includes(selectionNode.name.value) &&
              !selectionNode.arguments?.some((argNode) => argNode.name.value === 'id')
            ) {
              const existingArgs: ArgumentNode[] = []
              let firstArg: ArgumentNode | undefined
              let skipArg: ArgumentNode | undefined
              for (const existingArg of selectionNode.arguments ?? []) {
                if (existingArg.name.value === this.config.firstArgumentName) {
                  firstArg = existingArg
                } else if (existingArg.name.value === this.config.skipArgumentName) {
                  skipArg = existingArg
                } else {
                  existingArgs.push(existingArg)
                }
              }
              if (firstArg != null) {
                let numberOfTotalRecords: number | undefined
                if (firstArg.value.kind === Kind.INT) {
                  numberOfTotalRecords = parseInt(firstArg.value.value)
                } else if (firstArg.value.kind === Kind.VARIABLE) {
                  numberOfTotalRecords = executionRequest.variables?.[firstArg.value.name.value]
                }
                if (numberOfTotalRecords != null && numberOfTotalRecords > this.config.limitOfRecords) {
                  const fieldName = selectionNode.name.value
                  const aliasName = selectionNode.alias?.value || fieldName
                  let initialSkip = 0
                  if (skipArg?.value?.kind === Kind.INT) {
                    initialSkip = parseInt(skipArg.value.value)
                  } else if (skipArg?.value?.kind === Kind.VARIABLE) {
                    initialSkip = executionRequest.variables?.[skipArg.value.name.value]
                  }
                  let skip: number
                  for (
                    skip = initialSkip;
                    numberOfTotalRecords - skip + initialSkip > 0;
                    skip += this.config.limitOfRecords
                  ) {
                    newSelections.push({
                      ...selectionNode,
                      alias: {
                        kind: Kind.NAME,
                        value: `splitted_${skip}_${aliasName}`,
                      },
                      arguments: [
                        ...existingArgs,
                        {
                          kind: Kind.ARGUMENT,
                          name: {
                            kind: Kind.NAME,
                            value: this.config.firstArgumentName,
                          },
                          value: {
                            kind: Kind.INT,
                            value: Math.min(
                              numberOfTotalRecords - skip + initialSkip,
                              this.config.limitOfRecords,
                            ).toString(),
                          },
                        },
                        {
                          kind: Kind.ARGUMENT,
                          name: {
                            kind: Kind.NAME,
                            value: this.config.skipArgumentName,
                          },
                          value: {
                            kind: Kind.INT,
                            value: skip.toString(),
                          },
                        },
                      ],
                    })
                  }
                  continue
                }
              }
            }
            newSelections.push(selectionNode)
          }
          return {
            ...selectionSet,
            selections: newSelections,
          }
        },
      },
    })
    return {
      ...executionRequest,
      document,
    }
  }

  transformResult(originalResult: ExecutionResult<any>): ExecutionResult {
    if (originalResult.data != null) {
      const finalData = {}
      for (const fullAliasName in originalResult.data) {
        if (fullAliasName.startsWith('splitted_')) {
          const [, , aliasName] = fullAliasName.split('_')
          finalData[aliasName] = finalData[aliasName] || []
          for (const record of originalResult.data[fullAliasName]) {
            finalData[aliasName].push(record)
          }
        } else {
          finalData[fullAliasName] = originalResult.data[fullAliasName]
        }
      }
      return {
        ...originalResult,
        data: finalData,
      }
    }
    return originalResult
  }
}
