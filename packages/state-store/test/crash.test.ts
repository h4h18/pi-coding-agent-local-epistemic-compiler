import { expect, test } from "vitest";
import { CrashBeforeCommitError, SimulatedProcessTermination } from "../src/index.js";
import {
  artifact,
  digestOf,
  NOW,
  openTempStore,
  principalScope,
  reopenStore,
  seedHostAuthority,
} from "./helpers.js";

test("createUntrustedProject crash-before-commit leaves no project row", () => {
  const opened = openTempStore();
  try {
    seedHostAuthority(opened.store);
    const projectId = "proj-crash-create";
    const scope = principalScope([projectId]);
    opened.store.requestCrash("createUntrustedProject", "before-commit");
    expect(() => {
      opened.store.createUntrustedProject(scope, {
        projectId,
        displayName: projectId,
        classification: "internal",
        policy: artifact(digestOf("policy-crash"), "ProjectPolicy", "policy-crash"),
        createdAt: NOW,
      });
    }).toThrow(CrashBeforeCommitError);
    const reopened = reopenStore(opened);
    try {
      expect(() => reopened.getProject(scope, projectId)).toThrow();
    } finally {
      reopened.close();
    }
  } finally {
    opened.close();
  }
});

test("createUntrustedProject crash-after-commit keeps project and policy artifact", () => {
  const opened = openTempStore();
  try {
    seedHostAuthority(opened.store);
    const projectId = "proj-crash-create-after";
    const scope = principalScope([projectId]);
    opened.store.requestCrash("createUntrustedProject", "after-commit");
    expect(() => {
      opened.store.createUntrustedProject(scope, {
        projectId,
        displayName: projectId,
        classification: "internal",
        policy: artifact(digestOf("policy-crash-after"), "ProjectPolicy", "policy-crash-after"),
        createdAt: NOW,
      });
    }).toThrow(SimulatedProcessTermination);
    const reopened = reopenStore(opened);
    try {
      expect(reopened.getProject(scope, projectId).trustState).toBe("untrusted");
    } finally {
      reopened.close();
    }
  } finally {
    opened.close();
  }
});
