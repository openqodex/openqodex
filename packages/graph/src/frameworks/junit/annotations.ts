import type { Role } from "../plugin.js";

// Only these exact annotation identities prove a role.
export const ANNOTATIONS = new Map<string, Role>([
  ["org.junit.jupiter.api.Test", "test"],
  ["org.junit.jupiter.api.RepeatedTest", "test"],
  ["org.junit.jupiter.params.ParameterizedTest", "test"],
  ["org.junit.Test", "test"],
  ["org.junit.jupiter.api.BeforeEach", "fixture"],
  ["org.junit.jupiter.api.BeforeAll", "fixture"],
  ["org.junit.jupiter.api.AfterEach", "fixture"],
  ["org.junit.jupiter.api.AfterAll", "fixture"],
  ["org.junit.Before", "fixture"],
  ["org.junit.BeforeClass", "fixture"],
  ["org.junit.After", "fixture"],
  ["org.junit.AfterClass", "fixture"],
]);
export const SIMPLE_NAMES = new Set([...ANNOTATIONS.keys()].map((n) => n.slice(n.lastIndexOf(".") + 1)));
