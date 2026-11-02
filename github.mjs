const PR_FIELDS = `
  number title url isDraft updatedAt headRefName
  author { login }
  repository { nameWithOwner }
  reviewDecision mergeable mergeStateStatus
  reviewRequests { totalCount }
  latestReviews { totalCount }
  comments { totalCount }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { status } } } } } } }
`;

const search = (alias, q) =>
  `${alias}: search(query: ${JSON.stringify(`is:pr is:open archived:false ${q}`)}, type: ISSUE, first: 50) { nodes { ...F } }`;

export function buildQuery(repoPaths) {
  const searches = [
    search("authored", "author:@me"),
    search("reviewing", "review-requested:@me"),
    ...repoPaths.map((path, i) => search(`repo${i}`, `repo:${path}`)),
  ];
  return `query { ${searches.join("\n")} }\nfragment F on PullRequest { ${PR_FIELDS} }`;
}

const MERGE_STATUS = {
  CLEAN: "mergeable",
  HAS_HOOKS: "mergeable",
  UNSTABLE: "mergeable",
  DIRTY: "conflict",
  BEHIND: "need_rebase",
  BLOCKED: "not_approved",
  DRAFT: "draft_status",
};

export function pipelineOf(pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup) return null;
  const web_url = `${pr.url}/checks`;
  const state = rollup.state;
  if (state === "SUCCESS") return { id: null, status: "success", web_url };
  if (state === "FAILURE" || state === "ERROR") return { id: null, status: "failed", web_url };
  const inProgress = rollup.contexts?.nodes?.some((c) => c.__typename === "CheckRun" && c.status === "IN_PROGRESS");
  return { id: null, status: inProgress ? "running" : "pending", web_url };
}

export function prKey(pr) {
  return `github:${pr.repository.nameWithOwner}#${pr.number}`;
}

export function mapPullRequest(pr, { wasApproved = false, relationship = "other" } = {}) {
  const approved = pr.reviewDecision === "APPROVED";
  const hasConflicts = pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY";
  const needsRebase = pr.mergeStateStatus === "BEHIND";
  const needsReReview = wasApproved && !approved;
  const pipeline = pipelineOf(pr);

  return {
    host: "github",
    project_id: null,
    project: pr.repository.nameWithOwner,
    iid: pr.number,
    title: pr.title,
    web_url: pr.url,
    source_branch: pr.headRefName,
    author: pr.author?.login,
    draft: pr.isDraft,
    updated_at: pr.updatedAt,
    merge_status: MERGE_STATUS[pr.mergeStateStatus] ?? String(pr.mergeStateStatus ?? "unknown").toLowerCase(),
    approved,
    approvals_left: pr.reviewDecision === "REVIEW_REQUIRED" ? 1 : 0,
    has_reviewer: pr.reviewRequests.totalCount + pr.latestReviews.totalCount > 0,
    needs_rebase: needsRebase,
    has_conflicts: hasConflicts,
    needs_re_review: needsReReview,
    has_unresolved_threads: pr.reviewThreads.nodes.some((t) => !t.isResolved),
    comment_count: pr.comments.totalCount,
    pipeline,
    relationship,
    urgent: Boolean(pipeline?.status === "failed" || needsRebase || hasConflicts || needsReReview),
  };
}
