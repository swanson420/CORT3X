"""
Wraps calls to the DataHub MCP Server's get_lineage tool.

ISOLATION PRINCIPLE: connection/transport failures are raised as
DataHubUnreachableError, never as a lineage finding. A judge's
demo run against a cold-started local instance should get a clear
"couldn't reach DataHub" message, not a false HALT that looks like
a security event.

NOTE: the exact MCP client transport (stdio vs. HTTP, which SDK)
depends on how your local mcp-server-datahub instance is running.
This wraps whatever client you're using behind one call_tool()
choke point -- swap the internals, keep the interface.

CONFIRM AGAINST LIVE INSTANCE before trusting: real session/transport
shape. Run scripts/verify_mcp_contract.py to resolve this.
"""


class DataHubUnreachableError(Exception):
    """Raised when the MCP server can't be reached at all.
    Distinct from a lineage finding -- this is infra, not a security event."""
    pass


class DataHubMCPClient:
    def __init__(self, mcp_session):
        # mcp_session: whatever your actual MCP client session object is
        # (e.g. an mcp.ClientSession connected to the local server).
        # Confirm the exact import/connection shape against your running
        # instance -- this is the one piece that needs local verification,
        # not something safe to assume from documentation alone.
        self._session = mcp_session

    def get_lineage(self, entity_urn: str, direction: str = "upstream",
                     hops: int = 1) -> dict:
        """
        Calls the DataHub MCP get_lineage tool.
        Returns the raw lineage result dict on success.
        Raises DataHubUnreachableError on any connection/transport failure
        -- never lets a network problem masquerade as a lineage result.
        """
        try:
            result = self._session.call_tool(
                "get_lineage",
                arguments={
                    "urn": entity_urn,
                    "direction": direction,
                    "hops": hops,
                },
            )
        except Exception as exc:
            # Any transport-level failure gets isolated here, converted
            # to one known exception type -- callers never have to guess
            # what kind of underlying exception the MCP client library throws.
            raise DataHubUnreachableError(
                f"Could not reach DataHub MCP server for urn={entity_urn}: {exc}"
            ) from exc

        return result
