import { dynamicCatalog } from "../../src/providers/google-antigravity/dynamic-catalog.js";

/** Replace the runtime Antigravity snapshot used by a test with advertised models. */
export function setAntigravityModelsForTest(
  modelIds: readonly string[],
  accountIds: readonly string[] = [],
): void {
  dynamicCatalog.reset();
  const response = {
    models: Object.fromEntries(
      [...new Set(modelIds)].map((id) => [id, { quotaInfo: { remainingFraction: 1 } }]),
    ),
  };
  const owners = accountIds.length > 0 ? accountIds : ["__default__"];
  for (const accountId of owners) {
    dynamicCatalog.updateFromEndpointResponse(response, accountId);
  }
}

/** Give each account its own advertised catalog, as live polling does. */
export function setAntigravityAccountCatalogsForTest(
  catalogs: ReadonlyArray<readonly [accountId: string, modelIds: readonly string[]]>,
): void {
  dynamicCatalog.reset();
  for (const [accountId, modelIds] of catalogs) {
    dynamicCatalog.updateFromEndpointResponse({
      models: Object.fromEntries(
        [...new Set(modelIds)].map((id) => [id, { quotaInfo: { remainingFraction: 1 } }]),
      ),
    }, accountId);
  }
}
