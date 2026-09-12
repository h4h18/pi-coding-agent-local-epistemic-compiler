import {
  compileCloudContext,
  type CompilationOutcome,
  type CompilerInput,
} from "@pi-hec/context-compiler";

export { compileCloudContext as handleCompileContext };

export function handleContextFallback(input: CompilerInput): CompilationOutcome {
  return compileCloudContext(input);
}
