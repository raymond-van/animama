import { useProductApiClient } from "@animama/product-ui";
import type { Client } from "@animama/runtime-contracts/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { savePose } from "@animama/runtime-contracts/sdk";
import type { PyPose } from "@animama/runtime-contracts/api-types";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { toContentSaveApiError } from "@/lib/content/contentSaveErrors";
import type { PoseSaveInput } from "@/lib/content/poseContent";
import { queryKeys } from "@/query/keys";
import { sdkResultError } from "@/query/sdkResultError";

/** Submit the captured revision and operation unchanged, including retries. */
export async function savePoseContent(
  apiClient: Client,
  input: PoseSaveInput,
): Promise<PyPose> {
  if (!input.name.trim() || input.pose.parent)
    throw new Error("A named, resolved Pose is required.");
  if (Boolean(input.itemId) !== Boolean(input.expectedRevision))
    throw new Error("The loaded Pose revision is required.");
  try {
    const response = await savePose({
      client: apiClient,
      path: { entry_name: input.name },
      body: {
        operation_id: input.operationId,
        catalog_item_id: input.itemId,
        expected_revision: input.expectedRevision,
        descriptor_json: JSON.stringify({
          schema_version: 1,
          content_type: "pose",
          content_id: input.pose.id,
          name: input.name,
          pose: { ...input.pose, name: input.name },
        }),
      },
      requestValidator: undefined,
      responseValidator: undefined,
      throwOnError: false,
    });
    if (response.error !== undefined || !response.data)
      throw sdkResultError(response, (status, error) =>
        toContentSaveApiError(error, status),
      );
    return response.data;
  } catch (error) {
    throw toContentSaveApiError(error);
  }
}

/**
 * Pose Save refreshes only Pose and neutral catalog views, preserving loaded
 * draft revisions. Pose delete is the shared content delete
 * (`useDeleteContentItem`).
 */
export function usePoseContentActions() {
  const apiClient = useProductApiClient();

  const owner = useRuntimeCacheKey();
  const client = useQueryClient();
  const refresh = async () => {
    if (!owner) return;
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.poses.all(owner) }),
      client.invalidateQueries({ queryKey: queryKeys.content.catalog(owner) }),
    ]);
  };
  const save = useMutation({
    mutationKey: queryKeys.poses.save(owner ?? "__anon__"),
    mutationFn: savePoseContent.bind(null, apiClient),
    onSuccess: refresh,
  });
  return { savePose: save };
}
