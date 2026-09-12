import {
  fetchExternal,
  type ExternalFetchInput,
  type ExternalFetchResult,
} from "@pi-hec/repository";

export async function handleExternalFetch(input: ExternalFetchInput): Promise<ExternalFetchResult> {
  return fetchExternal(input);
}
