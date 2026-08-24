'use strict';

// Products and categories are the same algorithm over a different junction
// object and a different identifier field, so the whole difference lives here.
// `matchField` is what the CSV's identifier column is resolved against:
// SKU and ProductCode are the same value on Product2 in this system, and
// categories are addressed by their External_Id__c.
const ENTITIES = {
  product: {
    name: 'product',
    object: 'ProductMedia',
    parentField: 'ProductId',
    sobject: 'Product2',
    matchField: 'StockKeepingUnit',
    groups: ['productListImage', 'productDetailImage'],
  },
  category: {
    name: 'category',
    object: 'ProductCategoryMedia',
    parentField: 'ProductCategoryId',
    sobject: 'ProductCategory',
    matchField: 'External_Id__c',
    groups: ['tileImage'],
  },
};

// Every junction that can point at a ManagedContent, regardless of what this
// run selected. The unpublish guard scans all of them across all media groups:
// content shared with an out-of-scope group such as `attachment`, or with an
// entity this run never touched, must keep serving. Deliberately separate from
// ENTITIES so narrowing a run can never narrow the guard.
const ALL_MEDIA_JUNCTIONS = [
  { object: 'ProductMedia', parentField: 'ProductId' },
  { object: 'ProductCategoryMedia', parentField: 'ProductCategoryId' },
];

const ENTITY_NAMES = Object.keys(ENTITIES);
const ALL_GROUP_NAMES = [...new Set(Object.values(ENTITIES).flatMap((e) => e.groups))];

function resolveEntity(name) {
  const entity = ENTITIES[String(name || '').trim()];
  if (!entity) {
    throw new Error(`Unknown entity "${name}". Valid entities: ${ENTITY_NAMES.join(', ')}`);
  }
  return entity;
}

// Narrows an entity to a chosen subset of its media groups. Naming a group the
// entity does not own is a contradiction rather than an empty run, so it is
// refused with an explanation.
function restrictGroups(entity, groupNames) {
  if (!groupNames || groupNames.length === 0) return entity;

  const unknown = groupNames.filter((g) => !ALL_GROUP_NAMES.includes(g));
  if (unknown.length) {
    throw new Error(`Unknown --groups value(s): ${unknown.join(', ')}. Valid: ${ALL_GROUP_NAMES.join(', ')}`);
  }

  const groups = entity.groups.filter((g) => groupNames.includes(g));
  if (groups.length === 0) {
    const owners = groupNames
      .map((g) => `${g} -> ${ENTITY_NAMES.find((n) => ENTITIES[n].groups.includes(g))}`)
      .join(', ');
    throw new Error(
      `--groups ${groupNames.join(',')} selects nothing within --entity ${entity.name}. Those groups belong to: ${owners}`
    );
  }
  return { ...entity, groups };
}

// Which entity owns the named groups, so --groups can imply --entity rather
// than requiring both to be stated and kept consistent.
function entityForGroups(groupNames) {
  if (!groupNames || groupNames.length === 0) return null;
  const owners = ENTITY_NAMES.filter((n) => ENTITIES[n].groups.some((g) => groupNames.includes(g)));
  return owners.length === 1 ? owners[0] : null;
}

module.exports = { ENTITIES, ENTITY_NAMES, ALL_GROUP_NAMES, ALL_MEDIA_JUNCTIONS, resolveEntity, restrictGroups, entityForGroups };
