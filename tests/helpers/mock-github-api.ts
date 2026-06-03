// The GitHub-specific mock was generalized into a host-agnostic `MockHttpAPI`
// (see ./mock-http-api.ts) so providers other than GitHub can reuse it. This
// module is retained as a back-compat alias for the existing GitHub tests.
export { MockHttpAPI, MockHttpAPI as MockGitHubAPI } from "./mock-http-api.ts";
export type { MockResponse } from "./mock-http-api.ts";
