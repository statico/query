// eslint-disable-next-line @typescript-eslint/no-var-requires
const createV5UtilsObject = require('../utils')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const UnknownUsageError = require('../utils/unknown-usage-error')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const createQueryClientTransformer = require('../../../utils/transformers/query-client-transformer')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const createQueryCacheTransformer = require('../../../utils/transformers/query-cache-transformer')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const createUseQueryLikeTransformer = require('../../../utils/transformers/use-query-like-transformer')

/**
 * @param {import('jscodeshift').api} jscodeshift
 * @param {Object} utils
 * @param {import('jscodeshift').Collection} root
 * @param {string} filePath
 * @param {{keyName: "mutationKey"|"queryKey", queryClientMethods: ReadonlyArray<string>, hooks: ReadonlyArray<string>}} config
 */
const transformFilterAwareUsages = ({
  jscodeshift,
  utils,
  root,
  filePath,
  config,
}) => {
  const v5Utils = createV5UtilsObject({ jscodeshift, utils })

  /**
   * @param {import('jscodeshift').CallExpression} node
   * @param {"mutationKey"|"queryKey"} keyName
   * @returns {boolean}
   */
  const canSkipReplacement = (node, keyName) => {
    const callArguments = node.arguments

    const hasKeyProperty = () =>
      callArguments[0].properties.some(
        (property) =>
          utils.isObjectProperty(property) && property.key.name !== keyName,
      )

    /**
     * This call has at least one argument. If it's an object expression and contains the "queryKey" or "mutationKey"
     * field, the transformation can be skipped, because it's already matching the expected signature.
     */
    return (
      callArguments.length > 0 &&
      utils.isObjectExpression(callArguments[0]) &&
      hasKeyProperty()
    )
  }

  /**
   * This function checks whether the given object property is a spread element or a property that's not named
   * "queryKey" or "mutationKey".
   *
   * @param {import('jscodeshift').ObjectProperty} property
   * @returns {boolean}
   */
  const predicate = (property) => {
    const isSpreadElement = utils.isSpreadElement(property)
    const isObjectProperty = utils.isObjectProperty(property)

    return (
      isSpreadElement ||
      (isObjectProperty && property.key.name !== config.keyName)
    )
  }

  const replacer = (path) => {
    const node = path.node

    try {
      // If the given method/function call matches certain criteria, the node doesn't need to be replaced, this step can be skipped.
      if (canSkipReplacement(node, config.keyName)) {
        return node
      }

      /**
       * Here we attempt to determine the first parameter of the function call. If it's an array expression or an
       * identifier that references an array expression then we create an object property from it.
       *
       * @type {import('jscodeshift').Property|undefined}
       */
      const keyProperty = v5Utils.transformArgumentToKey(
        path,
        node.arguments[0],
        config.keyName,
        filePath,
      )

      /**
       * The first parameter couldn't be transformed into an object property, so it's time to throw an exception,
       * it will notify the consumers that they need to rewrite this usage manually.
       */
      if (!keyProperty) {
        throw new UnknownUsageError(node, filePath)
      }

      const parameters = [jscodeshift.objectExpression([keyProperty])]
      const secondParameter = node.arguments[1]

      if (secondParameter) {
        const createdObjectExpression = parameters[0]

        /**
         * If it has a second argument, and it's an object expression, then we get the properties from it
         * (except the "queryKey" or "mutationKey" properties), because these arguments will also be moved to the
         * newly created object expression.
         */
        if (utils.isObjectExpression(secondParameter)) {
          v5Utils.copyPropertiesFromSource(
            secondParameter,
            createdObjectExpression,
            predicate,
          )
        } else {
          // Otherwise, we simply spread the second parameter in the newly created object expression.
          createdObjectExpression.properties.push(
            jscodeshift.spreadElement(secondParameter),
          )
        }
      }

      // The rest of the parameters can be simply pushed to the parameters object so all will be kept.
      parameters.push(...node.arguments.slice(2))

      return jscodeshift.callExpression(node.original.callee, parameters)
    } catch (error) {
      utils.warn(
        error.name === UnknownUsageError.name
          ? error.message
          : `An unknown error occurred while processing the "${filePath}" file. Please review this file, because the codemod couldn't be applied.`,
      )

      return node
    }
  }

  createQueryClientTransformer({ jscodeshift, utils, root }).execute(
    config.queryClientMethods,
    replacer,
  )

  createUseQueryLikeTransformer({ jscodeshift, utils, root }).execute(
    config.hooks,
    replacer,
  )

  createQueryCacheTransformer({ jscodeshift, utils, root }).execute(replacer)
}

module.exports = transformFilterAwareUsages
