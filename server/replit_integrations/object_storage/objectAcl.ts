// NOTE: ACL types are kept for interface compatibility, but on local filesystem
// storage all files are treated as public (no per-file GCS metadata ACLs).

export enum ObjectAccessGroupType {}

export interface ObjectAccessGroup {
  type: ObjectAccessGroupType;
  id: string;
}

export enum ObjectPermission {
  READ = "read",
  WRITE = "write",
}

export interface ObjectAclRule {
  group: ObjectAccessGroup;
  permission: ObjectPermission;
}

export interface ObjectAclPolicy {
  owner: string;
  visibility: "public" | "private";
  aclRules?: Array<ObjectAclRule>;
}

// Sets the ACL policy on a file's sidecar metadata.
export async function setObjectAclPolicy(
  objectFile: any,
  aclPolicy: ObjectAclPolicy,
): Promise<void> {
  if (typeof objectFile?.setMetadata === "function") {
    await objectFile.setMetadata({
      metadata: { "custom:aclPolicy": JSON.stringify(aclPolicy) },
    });
  }
}

// Gets the ACL policy from a file's sidecar metadata.
// Falls back to public for local filesystem files.
export async function getObjectAclPolicy(
  objectFile: any,
): Promise<ObjectAclPolicy | null> {
  if (typeof objectFile?.getMetadata === "function") {
    try {
      const [meta] = await objectFile.getMetadata();
      const raw = meta?.metadata?.["custom:aclPolicy"];
      if (raw) return JSON.parse(raw as string);
    } catch {}
  }
  // Default: public
  return { owner: "system", visibility: "public" };
}

// On local filesystem storage every readable file is accessible.
export async function canAccessObject({
  requestedPermission,
}: {
  userId?: string;
  objectFile: any;
  requestedPermission: ObjectPermission;
}): Promise<boolean> {
  return requestedPermission === ObjectPermission.READ;
}
