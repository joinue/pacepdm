-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.approval_decisions (
  id text NOT NULL,
  requestId text NOT NULL,
  groupId text NOT NULL,
  deciderId text,
  status text NOT NULL DEFAULT 'PENDING'::text,
  comment text,
  decidedAt timestamp without time zone,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stepId text,
  signatureLabel text,
  approvalMode text DEFAULT 'ANY'::text,
  deadlineAt timestamp without time zone,
  CONSTRAINT approval_decisions_pkey PRIMARY KEY (id),
  CONSTRAINT approval_decisions_requestId_fkey FOREIGN KEY (requestId) REFERENCES public.approval_requests(id),
  CONSTRAINT approval_decisions_groupId_fkey FOREIGN KEY (groupId) REFERENCES public.approval_groups(id),
  CONSTRAINT approval_decisions_deciderId_fkey FOREIGN KEY (deciderId) REFERENCES public.tenant_users(id),
  CONSTRAINT approval_decisions_stepId_fkey FOREIGN KEY (stepId) REFERENCES public.approval_workflow_steps(id)
);
CREATE TABLE public.approval_group_members (
  id text NOT NULL,
  groupId text NOT NULL,
  userId text NOT NULL,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT approval_group_members_pkey PRIMARY KEY (id),
  CONSTRAINT approval_group_members_groupId_fkey FOREIGN KEY (groupId) REFERENCES public.approval_groups(id),
  CONSTRAINT approval_group_members_userId_fkey FOREIGN KEY (userId) REFERENCES public.tenant_users(id)
);
CREATE TABLE public.approval_groups (
  id text NOT NULL,
  tenantId text NOT NULL,
  name text NOT NULL,
  description text,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  isActive boolean NOT NULL DEFAULT true,
  CONSTRAINT approval_groups_pkey PRIMARY KEY (id),
  CONSTRAINT approval_groups_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id)
);
CREATE TABLE public.approval_history (
  id text NOT NULL,
  requestId text NOT NULL,
  event text NOT NULL,
  userId text,
  details text,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT approval_history_pkey PRIMARY KEY (id),
  CONSTRAINT approval_history_requestId_fkey FOREIGN KEY (requestId) REFERENCES public.approval_requests(id),
  CONSTRAINT approval_history_userId_fkey FOREIGN KEY (userId) REFERENCES public.tenant_users(id)
);
CREATE TABLE public.approval_requests (
  id text NOT NULL,
  tenantId text NOT NULL,
  type text NOT NULL,
  entityType text NOT NULL,
  entityId text NOT NULL,
  transitionId text,
  requestedById text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'::text,
  title text NOT NULL,
  description text,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  completedAt timestamp without time zone,
  workflowId text,
  currentStepOrder integer NOT NULL DEFAULT 1,
  clientRequestKey text,
  CONSTRAINT approval_requests_pkey PRIMARY KEY (id),
  CONSTRAINT approval_requests_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id),
  CONSTRAINT approval_requests_requestedById_fkey FOREIGN KEY (requestedById) REFERENCES public.tenant_users(id),
  CONSTRAINT approval_requests_workflowId_fkey FOREIGN KEY (workflowId) REFERENCES public.approval_workflows(id)
);
CREATE TABLE public.approval_workflow_assignments (
  id text NOT NULL,
  tenantId text NOT NULL,
  workflowId text NOT NULL,
  transitionId text,
  ecoTrigger text,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT approval_workflow_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT approval_workflow_assignments_workflowId_fkey FOREIGN KEY (workflowId) REFERENCES public.approval_workflows(id),
  CONSTRAINT approval_workflow_assignments_transitionId_fkey FOREIGN KEY (transitionId) REFERENCES public.lifecycle_transitions(id)
);
CREATE TABLE public.approval_workflow_steps (
  id text NOT NULL,
  workflowId text NOT NULL,
  groupId text NOT NULL,
  stepOrder integer NOT NULL DEFAULT 1,
  approvalMode text NOT NULL DEFAULT 'ANY'::text,
  signatureLabel text NOT NULL DEFAULT 'Approved'::text,
  deadlineHours integer,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT approval_workflow_steps_pkey PRIMARY KEY (id),
  CONSTRAINT approval_workflow_steps_workflowId_fkey FOREIGN KEY (workflowId) REFERENCES public.approval_workflows(id),
  CONSTRAINT approval_workflow_steps_groupId_fkey FOREIGN KEY (groupId) REFERENCES public.approval_groups(id)
);
CREATE TABLE public.approval_workflows (
  id text NOT NULL,
  tenantId text NOT NULL,
  name text NOT NULL,
  description text,
  isActive boolean NOT NULL DEFAULT true,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  CONSTRAINT approval_workflows_pkey PRIMARY KEY (id),
  CONSTRAINT approval_workflows_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id)
);
CREATE TABLE public.audit_logs (
  id text NOT NULL,
  tenantId text NOT NULL,
  userId text,
  action text NOT NULL,
  entityType text NOT NULL,
  entityId text NOT NULL,
  details jsonb,
  ipAddress text,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id),
  CONSTRAINT audit_logs_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id),
  CONSTRAINT audit_logs_userId_fkey FOREIGN KEY (userId) REFERENCES public.tenant_users(id)
);
CREATE TABLE public.bom_items (
  id text NOT NULL,
  bomId text NOT NULL,
  fileId text,
  itemNumber text NOT NULL,
  partNumber text,
  name text,
  description text,
  quantity double precision NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'EA'::text,
  level integer NOT NULL DEFAULT 1,
  parentItemId text,
  material text,
  vendor text,
  unitCost double precision,
  sortOrder integer NOT NULL DEFAULT 0,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  partId text,
  linkedBomId text,
  CONSTRAINT bom_items_pkey PRIMARY KEY (id),
  CONSTRAINT bom_items_bomId_fkey FOREIGN KEY (bomId) REFERENCES public.boms(id),
  CONSTRAINT bom_items_fileId_fkey FOREIGN KEY (fileId) REFERENCES public.files(id),
  CONSTRAINT bom_items_parentItemId_fkey FOREIGN KEY (parentItemId) REFERENCES public.bom_items(id),
  CONSTRAINT bom_items_partId_fkey FOREIGN KEY (partId) REFERENCES public.parts(id),
  CONSTRAINT bom_items_linkedBomId_fkey FOREIGN KEY (linkedBomId) REFERENCES public.boms(id)
);
CREATE TABLE public.boms (
  id text NOT NULL,
  tenantId text NOT NULL,
  fileId text,
  name text NOT NULL,
  revision text NOT NULL DEFAULT 'A'::text,
  status text NOT NULL DEFAULT 'DRAFT'::text,
  createdById text NOT NULL,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  CONSTRAINT boms_pkey PRIMARY KEY (id),
  CONSTRAINT boms_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id),
  CONSTRAINT boms_createdById_fkey FOREIGN KEY (createdById) REFERENCES public.tenant_users(id),
  CONSTRAINT boms_fileId_fkey FOREIGN KEY (fileId) REFERENCES public.files(id)
);
CREATE TABLE public.comment_mentions (
  id text NOT NULL DEFAULT gen_random_uuid(),
  tenantId text NOT NULL,
  userId text NOT NULL,
  mentionedBy text NOT NULL,
  entityType text NOT NULL,
  entityId text NOT NULL,
  comment text NOT NULL,
  createdAt timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT comment_mentions_pkey PRIMARY KEY (id)
);
CREATE TABLE public.eco_items (
  id text NOT NULL,
  ecoId text NOT NULL,
  fileId text,
  changeType text NOT NULL,
  reason text,
  partId text,
  fromRevision text,
  toRevision text,
  CONSTRAINT eco_items_pkey PRIMARY KEY (id),
  CONSTRAINT eco_items_ecoId_fkey FOREIGN KEY (ecoId) REFERENCES public.ecos(id),
  CONSTRAINT eco_items_fileId_fkey FOREIGN KEY (fileId) REFERENCES public.files(id),
  CONSTRAINT eco_items_partId_fkey FOREIGN KEY (partId) REFERENCES public.parts(id)
);
CREATE TABLE public.ecos (
  id text NOT NULL,
  tenantId text NOT NULL,
  ecoNumber text NOT NULL,
  title text NOT NULL,
  description text,
  status USER-DEFINED NOT NULL DEFAULT 'DRAFT'::"ECOStatus",
  priority USER-DEFINED NOT NULL DEFAULT 'MEDIUM'::"ECOPriority",
  createdById text NOT NULL,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  approvalRequestId text,
  reason USER-DEFINED,
  changeType USER-DEFINED,
  costImpact USER-DEFINED,
  disposition USER-DEFINED,
  effectivity text,
  implementedAt timestamp without time zone,
  implementedById text,
  CONSTRAINT ecos_pkey PRIMARY KEY (id),
  CONSTRAINT ecos_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id),
  CONSTRAINT ecos_approvalRequestId_fkey FOREIGN KEY (approvalRequestId) REFERENCES public.approval_requests(id),
  CONSTRAINT ecos_implementedById_fkey FOREIGN KEY (implementedById) REFERENCES public.tenant_users(id)
);
CREATE TABLE public.file_references (
  id text NOT NULL,
  sourceFileId text NOT NULL,
  targetFileId text NOT NULL,
  referenceType text NOT NULL DEFAULT 'contains'::text,
  CONSTRAINT file_references_pkey PRIMARY KEY (id),
  CONSTRAINT file_references_sourceFileId_fkey FOREIGN KEY (sourceFileId) REFERENCES public.files(id),
  CONSTRAINT file_references_targetFileId_fkey FOREIGN KEY (targetFileId) REFERENCES public.files(id)
);
CREATE TABLE public.file_versions (
  id text NOT NULL,
  fileId text NOT NULL,
  version integer NOT NULL,
  storageKey text NOT NULL,
  fileSize integer NOT NULL,
  checksum text,
  uploadedById text NOT NULL,
  comment text,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision text NOT NULL DEFAULT 'A'::text,
  ecoId text,
  CONSTRAINT file_versions_pkey PRIMARY KEY (id),
  CONSTRAINT file_versions_fileId_fkey FOREIGN KEY (fileId) REFERENCES public.files(id),
  CONSTRAINT file_versions_uploadedById_fkey FOREIGN KEY (uploadedById) REFERENCES public.tenant_users(id),
  CONSTRAINT file_versions_ecoId_fkey FOREIGN KEY (ecoId) REFERENCES public.ecos(id)
);
CREATE TABLE public.files (
  id text NOT NULL,
  tenantId text NOT NULL,
  folderId text NOT NULL,
  name text NOT NULL,
  partNumber text,
  description text,
  fileType text NOT NULL,
  category USER-DEFINED NOT NULL DEFAULT 'DOCUMENT'::"FileCategory",
  currentVersion integer NOT NULL DEFAULT 1,
  lifecycleState text NOT NULL DEFAULT 'WIP'::text,
  lifecycleId text,
  isCheckedOut boolean NOT NULL DEFAULT false,
  checkedOutById text,
  checkedOutAt timestamp without time zone,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  revision text NOT NULL DEFAULT 'A'::text,
  isFrozen boolean NOT NULL DEFAULT false,
  thumbnailKey text,
  thumbnailAttemptedAt timestamp without time zone,
  createdById text,
  CONSTRAINT files_pkey PRIMARY KEY (id),
  CONSTRAINT files_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id),
  CONSTRAINT files_folderId_fkey FOREIGN KEY (folderId) REFERENCES public.folders(id),
  CONSTRAINT files_lifecycleId_fkey FOREIGN KEY (lifecycleId) REFERENCES public.lifecycles(id),
  CONSTRAINT files_checkedOutById_fkey FOREIGN KEY (checkedOutById) REFERENCES public.tenant_users(id),
  CONSTRAINT files_createdById_fkey FOREIGN KEY (createdById) REFERENCES public.tenant_users(id)
);
CREATE TABLE public.folder_access (
  id text NOT NULL,
  tenantId text NOT NULL,
  folderId text NOT NULL,
  principalType USER-DEFINED NOT NULL,
  principalId text NOT NULL,
  level USER-DEFINED NOT NULL,
  effect USER-DEFINED NOT NULL DEFAULT 'ALLOW'::"FolderAccessEffect",
  inherited boolean NOT NULL DEFAULT true,
  grantedById text,
  grantedAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiresAt timestamp without time zone,
  note text,
  CONSTRAINT folder_access_pkey PRIMARY KEY (id),
  CONSTRAINT folder_access_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id),
  CONSTRAINT folder_access_folderId_fkey FOREIGN KEY (folderId) REFERENCES public.folders(id),
  CONSTRAINT folder_access_grantedById_fkey FOREIGN KEY (grantedById) REFERENCES public.tenant_users(id)
);
CREATE TABLE public.folder_permissions (
  id text NOT NULL,
  folderId text NOT NULL,
  userId text,
  roleId text,
  access text NOT NULL DEFAULT 'VIEW'::text,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT folder_permissions_pkey PRIMARY KEY (id),
  CONSTRAINT folder_permissions_folderId_fkey FOREIGN KEY (folderId) REFERENCES public.folders(id),
  CONSTRAINT folder_permissions_userId_fkey FOREIGN KEY (userId) REFERENCES public.tenant_users(id),
  CONSTRAINT folder_permissions_roleId_fkey FOREIGN KEY (roleId) REFERENCES public.roles(id)
);
CREATE TABLE public.folders (
  id text NOT NULL,
  tenantId text NOT NULL,
  name text NOT NULL,
  parentId text,
  path text NOT NULL,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  isRestricted boolean NOT NULL DEFAULT false,
  CONSTRAINT folders_pkey PRIMARY KEY (id),
  CONSTRAINT folders_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id),
  CONSTRAINT folders_parentId_fkey FOREIGN KEY (parentId) REFERENCES public.folders(id)
);
CREATE TABLE public.lifecycle_states (
  id text NOT NULL,
  lifecycleId text NOT NULL,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#6B7280'::text,
  isInitial boolean NOT NULL DEFAULT false,
  isFinal boolean NOT NULL DEFAULT false,
  sortOrder integer NOT NULL DEFAULT 0,
  CONSTRAINT lifecycle_states_pkey PRIMARY KEY (id),
  CONSTRAINT lifecycle_states_lifecycleId_fkey FOREIGN KEY (lifecycleId) REFERENCES public.lifecycles(id)
);
CREATE TABLE public.lifecycle_transitions (
  id text NOT NULL,
  lifecycleId text NOT NULL,
  fromStateId text NOT NULL,
  toStateId text NOT NULL,
  name text NOT NULL,
  requiresApproval boolean NOT NULL DEFAULT false,
  approvalRoles jsonb,
  CONSTRAINT lifecycle_transitions_pkey PRIMARY KEY (id),
  CONSTRAINT lifecycle_transitions_lifecycleId_fkey FOREIGN KEY (lifecycleId) REFERENCES public.lifecycles(id),
  CONSTRAINT lifecycle_transitions_fromStateId_fkey FOREIGN KEY (fromStateId) REFERENCES public.lifecycle_states(id),
  CONSTRAINT lifecycle_transitions_toStateId_fkey FOREIGN KEY (toStateId) REFERENCES public.lifecycle_states(id)
);
CREATE TABLE public.lifecycles (
  id text NOT NULL,
  tenantId text NOT NULL,
  name text NOT NULL,
  isDefault boolean NOT NULL DEFAULT false,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  CONSTRAINT lifecycles_pkey PRIMARY KEY (id),
  CONSTRAINT lifecycles_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id)
);
CREATE TABLE public.metadata_fields (
  id text NOT NULL,
  tenantId text NOT NULL,
  name text NOT NULL,
  fieldType USER-DEFINED NOT NULL DEFAULT 'TEXT'::"MetadataType",
  options jsonb,
  isRequired boolean NOT NULL DEFAULT false,
  isSystem boolean NOT NULL DEFAULT false,
  sortOrder integer NOT NULL DEFAULT 0,
  appliesTo ARRAY,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  CONSTRAINT metadata_fields_pkey PRIMARY KEY (id),
  CONSTRAINT metadata_fields_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id)
);
CREATE TABLE public.metadata_values (
  id text NOT NULL,
  fileId text NOT NULL,
  fieldId text NOT NULL,
  value text NOT NULL,
  CONSTRAINT metadata_values_pkey PRIMARY KEY (id),
  CONSTRAINT metadata_values_fileId_fkey FOREIGN KEY (fileId) REFERENCES public.files(id),
  CONSTRAINT metadata_values_fieldId_fkey FOREIGN KEY (fieldId) REFERENCES public.metadata_fields(id)
);
CREATE TABLE public.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenantId text NOT NULL,
  userId text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  type text NOT NULL DEFAULT 'system'::text,
  link text,
  isRead boolean NOT NULL DEFAULT false,
  createdAt timestamp with time zone NOT NULL DEFAULT now(),
  refId text,
  actorId text,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_actorId_fkey FOREIGN KEY (actorId) REFERENCES public.tenant_users(id)
);
CREATE TABLE public.part_files (
  id text NOT NULL,
  partId text NOT NULL,
  fileId text NOT NULL,
  role text NOT NULL DEFAULT 'DRAWING'::text,
  isPrimary boolean NOT NULL DEFAULT false,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT part_files_pkey PRIMARY KEY (id),
  CONSTRAINT part_files_partId_fkey FOREIGN KEY (partId) REFERENCES public.parts(id),
  CONSTRAINT part_files_fileId_fkey FOREIGN KEY (fileId) REFERENCES public.files(id)
);
CREATE TABLE public.part_vendors (
  id text NOT NULL,
  partId text NOT NULL,
  vendorName text NOT NULL,
  vendorPartNumber text,
  unitCost double precision,
  currency text NOT NULL DEFAULT 'USD'::text,
  leadTimeDays integer,
  isPrimary boolean NOT NULL DEFAULT false,
  notes text,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  vendorId text NOT NULL,
  CONSTRAINT part_vendors_pkey PRIMARY KEY (id),
  CONSTRAINT part_vendors_partId_fkey FOREIGN KEY (partId) REFERENCES public.parts(id),
  CONSTRAINT part_vendors_vendorId_fkey FOREIGN KEY (vendorId) REFERENCES public.vendors(id)
);
CREATE TABLE public.parts (
  id text NOT NULL,
  tenantId text NOT NULL,
  partNumber text NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'MANUFACTURED'::text,
  revision text NOT NULL DEFAULT 'A'::text,
  lifecycleState text NOT NULL DEFAULT 'WIP'::text,
  material text,
  weight double precision,
  weightUnit text DEFAULT 'kg'::text,
  unitCost double precision,
  currency text NOT NULL DEFAULT 'USD'::text,
  unit text NOT NULL DEFAULT 'EA'::text,
  thumbnailUrl text,
  notes text,
  createdById text NOT NULL,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  CONSTRAINT parts_pkey PRIMARY KEY (id),
  CONSTRAINT parts_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id),
  CONSTRAINT parts_createdById_fkey FOREIGN KEY (createdById) REFERENCES public.tenant_users(id)
);
CREATE TABLE public.roles (
  id text NOT NULL,
  tenantId text NOT NULL,
  name text NOT NULL,
  description text,
  permissions jsonb NOT NULL,
  isSystem boolean NOT NULL DEFAULT false,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  canEdit boolean NOT NULL DEFAULT true,
  CONSTRAINT roles_pkey PRIMARY KEY (id),
  CONSTRAINT roles_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id)
);
CREATE TABLE public.saved_searches (
  id text NOT NULL,
  tenantId text NOT NULL,
  userId text NOT NULL,
  name text NOT NULL,
  filters jsonb NOT NULL,
  isShared boolean NOT NULL DEFAULT false,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  CONSTRAINT saved_searches_pkey PRIMARY KEY (id),
  CONSTRAINT saved_searches_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id),
  CONSTRAINT saved_searches_userId_fkey FOREIGN KEY (userId) REFERENCES public.tenant_users(id)
);
CREATE TABLE public.tenant_users (
  id text NOT NULL,
  tenantId text NOT NULL,
  authUserId text NOT NULL,
  email text NOT NULL,
  fullName text NOT NULL,
  roleId text NOT NULL,
  isActive boolean NOT NULL DEFAULT true,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  CONSTRAINT tenant_users_pkey PRIMARY KEY (id),
  CONSTRAINT tenant_users_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id),
  CONSTRAINT tenant_users_roleId_fkey FOREIGN KEY (roleId) REFERENCES public.roles(id)
);
CREATE TABLE public.tenants (
  id text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  partNumberSequence integer NOT NULL DEFAULT 0,
  CONSTRAINT tenants_pkey PRIMARY KEY (id)
);
CREATE TABLE public.vendors (
  id text NOT NULL,
  tenantId text NOT NULL,
  name text NOT NULL,
  website text,
  contactName text,
  contactEmail text,
  contactPhone text,
  notes text,
  createdAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT vendors_pkey PRIMARY KEY (id),
  CONSTRAINT vendors_tenantId_fkey FOREIGN KEY (tenantId) REFERENCES public.tenants(id)
);