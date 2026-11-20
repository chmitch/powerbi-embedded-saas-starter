# Platform and tenant administration

The **platform admin runs the hosting environment and onboards tenants**.
The **tenant admin runs the user and content experience inside one tenant**.
These are application roles, not Entra directory roles or automatic Fabric/Azure
permissions. This guide explains tenant provisioning, administrator appointments,
and day-to-day user, permission and content workflows.

[Setup and deployment](../README.md#setup) |
[Architecture and authorization](../ARCHITECTURE.md#tenant-isolation-and-authorization)

## Who owns what?

| Responsibility | Platform admin | Tenant admin |
| --- | --- | --- |
| Create a tenant or adopt an existing workspace | Yes | No |
| Create/select customer capacity and assign workspaces | Yes | No |
| Resize, pause, resume or delete customer capacity | Yes, subject to safeguards | No |
| Provision the tenant embedding identity and workspace access | Yes, through the backend setup flow | No |
| Appoint, replace or revoke tenant administrators | Yes | No; cannot promote users to admin |
| Register ordinary users and set their application permissions | Not through platform status alone | Yes, for their own tenant |
| Synchronize, review and publish tenant content | Not through platform status alone | Yes, for their own tenant |
| Add the fixed bundled sample report/model | Optional during new-tenant creation | Yes, later in their ready tenant |
| Manage folders, report labels and inherited access | Not through platform status alone | Yes, for their own tenant |
| View/edit/create/copy reports | Requires explicit tenant membership and item/model permissions | Requires item/model permissions, not just the admin role |
| Change global Fabric settings, directory policy or Azure quota | Not granted by this application role | Not granted by this application role |

A platform-only administrator can have no tenant membership. A person holding
both roles uses separate **Platform admin** and **Tenant admin** views and still
belongs to at most one application tenant. Platform status never provides a
portal shortcut into another tenant's reports.

The dedicated management workspace/F2 hosts application SQL, not customer reports.
It is protected from adoption, customer assignment and in-app capacity mutation.
The optional automatic-resume policy is a narrow, explicitly enabled exception.
Customer workspaces remain separate even when they share customer capacity.

## Platform admin: provision a new tenant

### Decisions the administrator makes

In **Platform admin**, supply:

1. **Workspace name:** the tenant-facing name used for the tenant and its workspace.
2. **Primary administrator:** an existing user's exact Entra sign-in UPN in the
   configured directory, not an email alias. The backend resolves the immutable
   directory object ID and checks membership before starting resource creation.
3. **Capacity:** choose an active existing customer capacity, including one
   already shared with other tenants, or select a new size and explicitly
   acknowledge its billing.
4. **Include sample (optional, off by default):** seed the new tenant with the
   bundled Store Sales report and semantic model. This explicitly approves
   importing and publishing that sample; no arbitrary PBIX upload is exposed.

Select **Provision tenant**. The platform admin does not manually assemble the
service principal, secret and workspace; the backend performs those steps.
The application role does not grant missing upstream permissions: the operator
still needs the relevant delegated workspace/assignment rights, and deployment's
provisioning identity needs its configured Graph/ARM/credential-store grants.
Required Fabric service-principal/embedding settings must already be enabled.

### What the backend creates, in order

Identity preparation precedes capacity/workspace creation in the current flow.

| Step | Backend action | Result |
| --- | --- | --- |
| 1. Register the setup request | Validate platform authority, administrator identity/membership and capacity choice; transactionally create the pending tenant, navigation root and idempotent SQL operation | A manageable pending tenant and durable progress record, not a ready report experience |
| 2. Prepare the tenant identity | Create/reuse an Entra app registration and service principal, store its generated credential in Key Vault in production, and add configured embedding-group membership | A dedicated non-human identity for this tenant; credentials never reach the browser |
| 3. Prepare capacity | Reuse the selected active customer capacity, or create a billable capacity in the configured region/resource group and wait for ARM/Fabric availability | An eligible customer compute destination; management F2 is excluded |
| 4. Create the workspace | Create the Fabric/Power BI workspace and persist its exclusive tenant mapping | One assigned workspace for this application tenant |
| 5. Grant runtime access | Give the configured tenant service principal workspace **Admin** access | The backend can perform supported embedding/authoring operations as that tenant identity |
| 6. Assign compute | Assign the workspace to the chosen capacity and wait for observed assignment | The workspace uses that compute; other tenants' assignments are not removed |
| 7. Appoint the tenant admin | Register/attach the selected human identity, set its tenant-admin flag and primary-admin metadata, and grant the new tenant's initial permission defaults | A person responsible for administering the tenant in this application |
| 8. Verify runtime readiness | Verify the workspace/name/capacity and access with the actual tenant embedding principal | Runtime access established before optional sample import |
| 9. Include sample, if selected | Import `samples\Store Sales.pbix` using the tenant principal, wait for the import, synchronize inventory/navigation, and publish only its report/model | Sample metadata in application SQL and a published report available through normal user permissions; setup completes afterward |

The human tenant administrator and the tenant service principal are **different
identities**. Step 5 grants the service principal a Fabric workspace role; step 7
grants the human an application role. Appointing the human does not automatically
make them a Fabric workspace Admin, Azure capacity admin or Entra administrator.
An empty ready tenant is valid when **Include sample** is not selected. When
selected, the new tenant's initial admin can view/edit the published sample through
their full root defaults. Other users still need membership and permission grants;
seeding does not grant platform admins tenant content access.

### Appointing and changing tenant administrators

Only a platform admin can make these appointments:

- The initial admin is selected during guided creation. For a **new tenant**,
  this user receives all seven current root permission flags, in addition to
  tenant-admin status. Publication, inheritance breaks and model security still
  apply; this is not an authorization bypass.
- **Additional tenant administrators** accepts an exact UPN or manual
  object-ID/display-name pair. It can promote an existing member of that tenant
  or attach an unassigned platform-only admin, but rejects a user already bound
  to another tenant. New additional admins receive no automatic report grants;
  existing permissions are preserved.
- Replacing the **primary** admin in tenant settings requires confirmation.
  The former primary loses only tenant-admin status; their membership/content
  permissions and other administrators remain unchanged. The new primary does
  not automatically inherit the old primary's report grants or receive the
  new-tenant initial full-permission grant.
- Revoking an administrator role likewise preserves membership and content
  permissions. It is not complete offboarding or removal of report access.

The same user cannot be assigned across multiple application tenants. Creating a
second tenant is not an implicit user-transfer operation. Additional-admin manual
ID entry is available when directory lookup is unavailable; guided new-tenant
creation itself requires the administrator UPN.

### Existing tenants, failures and handoff

Existing tenant settings reuse the workspace and service principal; renaming or
changing capacity does not recreate content or reset ACLs. Existing-workspace
adoption is a separate, explicit path requiring verifiable operator workspace
Admin access. Adoption does not automatically grant application membership,
publish existing reports, or repair all missing runtime/capacity configuration.

The progress display records each step. Failures preserve resources/checkpoints;
use **Retry unfinished steps** as the original operator. After an interrupted
process, allow up to 90 seconds for its worker lease to expire. Unknown app/
workspace creation outcomes require manual reconciliation, not blind recreation.
Failed/new capacity can continue billing; there is no automatic cloud rollback.

Initial sample seeding is available on **Provision a tenant**, not existing-tenant
platform settings or adoption. A tenant admin can also add it later from their
own console. Saved import IDs are reused after import polling or
metadata failures. If upload acceptance is unknown without a saved import ID, or
Power BI marks the import failed, reconcile that tenant's workspace/import
history manually; automatic duplicate upload, overwrite and cleanup are blocked.

At handoff, the tenant admin should know the tenant/workspace identity, that they
have been assigned the application role, and whether content still needs loading.
**Tenant ready does not imply customer content has been loaded or user grants
have been assigned.** The selected bundled sample is imported and published
before setup completes; otherwise content onboarding remains a tenant-admin task.

## Tenant admin: run the tenant experience

### Add users

Open **Tenant admin > Tenant users** and register an existing directory user by
exact Entra UPN, or use the manual object-ID/display-name alternative.
Choose the user's root/default permissions as part of registration.

This adds an **application membership**, not a new Entra account, guest invitation
or Fabric workspace user. The user must already exist in the configured directory
and cannot be registered into a second tenant. Membership alone does not grant
report access beyond the explicitly assigned defaults.
Tenant admins cannot appoint other tenant admins or change platform-admin flags.

### Grant user permissions

Set tenant-wide root defaults in **Tenant users**. Use **Folder and report access**
for grants on a specific folder/report, and choose whether a navigation node
inherits ancestor/default grants. All choices stay within the current tenant.

| User task | Required application access |
| --- | --- |
| View a report | `ViewReport` on that published report, with supported model dependencies |
| Edit an existing report | `ViewReport` + `EditReport` on the report, plus `UseSemanticModelForAuthoring` on its published model |
| Create a report | Root `CreateReport` plus `UseSemanticModelForAuthoring` on the selected published model |
| Save As / copy | Source view/edit/copy permissions, root `CreateReport`, and authoring permission on the published model |
| Rename a report's navigation label as an end user | Effective `ManageNavigation` on that report; its Fabric artifact name is unchanged |

For selective access, start with no broad root permissions, then grant
`ViewReport` on the intended folder/report. Granting zero bits on a child does
**not** deny an inherited grant; use an inheritance break to stop ancestor/root
permissions. Parent/folder changes can therefore change access.

There are no configurable role bundles or explicit-deny rules yet. Permissions
control the action as well as visibility: hiding a navigation link alone is not
security. Changes are checked on future token issuance/renewal; already issued
Power BI embed tokens may remain usable until expiry.

### Add and publish content

For a demo, select **Tenant admin > Content and publication > Add sample report**.
The tenant must have a ready assigned workspace. This imports and automatically
publishes the bundled Store Sales report/model, creates their SQL metadata and
navigation entries, and displays progress with a retry option for the original
administrator. No infrastructure, administrator roles or user grants are changed;
users, including tenant admins, still need normal report/model permissions.

The action recognizes samples included during initial setup or added previously.
It does not upload duplicates, overwrite an existing report or automatically
republish a sample later unpublished by an admin. Use **Publish** in the content
table to republish it deliberately. If interrupted, the original still-authorized
admin can use **Retry sample report** after lease expiry; the saved import ID is
reused. Unknown/failed imports require manual reconciliation. Failed sample
addition leaves the tenant's other reports available. Failures in initial
platform setup must still be resumed by its original platform operator.

There are two distinct publication steps: placing artifacts in Fabric, and
approving their availability in this application.

1. **Load the assigned workspace.** Publish/deploy reports and semantic models
   using supported external Power BI/Fabric tooling. The publishing identity
   needs its own Fabric permissions and any applicable license; the application's
   tenant-admin role does not grant those external rights.
2. **Discover the artifacts.** Choose **Synchronize workspace**. The backend
   inventories only this tenant's assigned workspace, records reports/models and
   dependencies, and creates the application navigation/security records.
   The in-process five-minute reconciler also discovers out-of-band changes.
3. **Review and approve.** Newly discovered content is **Unreviewed/unpublished**.
   In **Content and publication**, approve the intended reports and the models
   needed for authoring. Unsupported model security/dependencies block approval
   or embedding; there is no unfiltered fallback.
4. **Organize and grant access.** In **Tenant navigation**, add folders, move/
   order items and change display labels. Use separate user/access controls to
   grant the intended operations. Publication does not grant a user permission.
5. **Verify as the intended user.** Sign in with an ordinary tenant account and
   check the expected reports/actions. Admin status or infrastructure readiness
   is not a substitute for this check.

Authorized users can also create reports or copies inside the embedded
experience. Confirmed saves trigger inventory reconciliation; new reports/copies
still need review/publication before ordinary catalog access. The destination
remains the user's assigned tenant workspace.

**Current limit:** apart from the fixed bundled sample in setup/tenant administration,
the portal has no general-purpose PBIX upload or semantic-model deployment
screen. `ManageContent` is a defined permission bit, not an implemented upload
feature. Future upload must be tenant-scoped and available to users with that
effective permission, not only tenant admins. Data-source credentials, gateways,
effective-identity RLS, and chained/composite models remain outside the supported
initial content workflow.

The hierarchy is shared by the tenant, not customized per user. Tenant admins
manage their own users/content/navigation; capacity lifecycle, tenant creation,
service-principal setup and admin appointments remain platform responsibilities.
Application ACLs do not revoke any direct Fabric access a person holds separately.
