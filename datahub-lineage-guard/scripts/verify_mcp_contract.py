"""
Run this ONCE against your live local DataHub MCP server to resolve
the three open flags before trusting anything in lineage_comparator.py,
mcp_client.py, or writeback.py:

  1. Real session/transport shape (how you actually connect)
  2. Real get_lineage response keys (does it say "upstream" or something else)
  3. Real mutation tool name (is it add_tag, or something else entirely)

This is intentionally NOT a pytest test -- it's a one-shot probe you
run and read the output of by hand. Do not wire this into CI.

TRIAGE RUBRIC when reading the output:
  - Tool missing entirely from Step 1's list -> infra/config problem
    (wrong server, wrong version) -- code cannot fix a tool that isn't
    exposed.
  - Tool present in Step 1, but the call in Step 2 errors -> likely a
    real code bug in how the call is made.
  - Step 2 returns data under different keys than "upstream"/"urn" ->
    schema mismatch -- fix _extract_upstream_urns() in
    lineage_comparator.py to match reality.
  - Step 3 shows ZERO mutation tools at all -> server-side config gap,
    check TOOLS_IS_MUTATION_ENABLED=true is set on your instance. This
    is NOT a client-code bug -- don't go rewrite writeback.py chasing
    a tool name that simply isn't turned on server-side.
  - Step 3 shows mutation tools, but none named "add_tag" -> real code
    fix -- rename the call in writeback.py to whatever's actually there.
"""


# --- STEP 0: however you actually connect locally, put it here. ---
# This is the one part that cannot be written blind -- it depends on
# whether your local mcp-server-datahub is running over stdio or HTTP,
# and which MCP client library you're using to reach it. Fill in the
# real connection here before running anything below.
#
# session = <your real connected MCP session object>


def verify_contract(session):
    print("=" * 60)
    print("STEP 1: List all tools the server actually exposes")
    print("=" * 60)
    tools = session.list_tools()
    for tool in tools:
        print(f"  - {tool.name}")
        if getattr(tool, "annotations", None):
            print(f"      readOnlyHint: {getattr(tool.annotations, 'readOnlyHint', 'unknown')}")

    tool_names = {t.name for t in tools}

    print()
    print("=" * 60)
    print("STEP 2: Confirm get_lineage is present, call it for real")
    print("=" * 60)
    if "get_lineage" not in tool_names:
        print("  !! get_lineage NOT in tool list -- name/version mismatch, stop here.")
        return

    # Replace with a real URN that exists in your ingested sample data.
    # If you don't know one yet, run the `search` tool first to find one.
    test_urn = "REPLACE_WITH_REAL_URN_FROM_YOUR_INSTANCE"
    raw = session.call_tool("get_lineage", arguments={
        "urn": test_urn, "direction": "upstream", "hops": 1,
    })
    print(f"  Raw response for {test_urn}:")
    print(f"  {raw!r}")
    print()
    print("  >> COMPARE this shape against _extract_upstream_urns() in")
    print("     lineage_comparator.py -- does it actually have an")
    print("     'upstream' key with 'urn' fields inside, or different names?")

    print()
    print("=" * 60)
    print("STEP 3: Confirm the real mutation tool name for tagging")
    print("=" * 60)
    mutation_candidates = [t for t in tools
                            if getattr(t.annotations, "readOnlyHint", True) is False]
    if not mutation_candidates:
        print("  !! No mutation tools visible -- check TOOLS_IS_MUTATION_ENABLED=true")
        print("     is actually set on your local server instance.")
        print("     (This is a server-config gap, not a client code bug --")
        print("      see the triage rubric at the top of this file.)")
    else:
        print("  Mutation tools actually available:")
        for t in mutation_candidates:
            print(f"    - {t.name}")
        print()
        print("  >> COMPARE against 'add_tag' hardcoded in writeback.py --")
        print("     if the real name differs, that's the fix needed there.")

    print()
    print("=" * 60)
    print("RECORD FOR SUBMISSION DESCRIPTION (8d):")
    print(f"  dataset queried: <fill in from what you searched/ingested>")
    print(f"  demo entity URN: {test_urn}")
    print("=" * 60)


if __name__ == "__main__":
    print("Fill in `session` at the top of this file with your real")
    print("connected MCP client session before running.")
    # verify_contract(session)
