import data from "./gateway-feature-schema-data.json" with { type: "json" };
/** Generated from the pinned SDK's config.schema.json; the native engine can be newer. */
export interface TableSchema {
  /** Accepted field names; undefined means a map whose keys are free and whose values follow `values`. */
  fields?: ReadonlySet<string>;
  /** Strict sub-tables by field name. */
  nested: ReadonlyMap<string, TableSchema>;
  values?: TableSchema;
}
export interface FeatureSchema extends TableSchema {
  /** The SDK field is a plain table, not a boolean-or-table `FeatureToml`. */
  tableOnly?: boolean;
}

interface JsonTable { fields?: string[]; nested: Record<string, JsonTable>; values?: JsonTable; tableOnly?: boolean }
const table = (value: JsonTable): FeatureSchema => ({
  ...(value.fields ? { fields: new Set(value.fields) } : {}),
  nested: new Map(Object.entries(value.nested).map(([key, entry]) => [key, table(entry)])),
  ...(value.values ? { values: table(value.values) } : {}),
  ...(value.tableOnly ? { tableOnly: true } : {}),
});
const features: Record<string, FeatureSchema> = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, table(value)]));

export const featureSchema = (name: string): FeatureSchema | undefined => Object.hasOwn(features, name) ? features[name] : undefined;
