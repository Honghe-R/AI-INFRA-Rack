# Database scripts

Run migrations in lexical order against PostgreSQL 16 with PostGIS enabled. `001_facility_schema.sql` creates the initial transactional store for the Site and Facility Editor per [D15](../doc/tools/site-and-facility/decisions.md), implementing the canonical entity model in [entity-model.md](../doc/tools/site-and-facility/entity-model.md) and the canonical enumerations in [interchange-contract.md](../doc/tools/site-and-facility/interchange-contract.md). Tenant isolation uses row-level security, and normalized geometry is stored in PostGIS spatial columns with GiST indexes.

The schema applies the tenant-key discipline from [D22](../doc/tools/site-and-facility/decisions.md): `project_id` is part of every primary key, unique constraint, and foreign key, so a stored reference cannot cross projects. The append-only classes `outbox_events` and `import_features` are range-partitioned by time so retention expiry is a partition operation. `facility_diagnostics` stays unpartitioned because its self-referencing `supersedes_diagnostic_id` foreign key cannot survive time partitioning.

Source artifacts themselves belong in object storage; the database stores immutable references and checksums.
