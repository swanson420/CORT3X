"""
src/errors.py

PART 1 FIX (red-team finding #8): a single undifferentiated IntegrityError
was raised for every failure mode -- a concurrent writer losing a race,
a forged/tampered hash, and a broken parent link were all indistinguishable
to callers. That makes retry logic, logging, and alerting impossible to
get right: you *should* silently retry a concurrency loss, but you should
never silently retry (or ignore) a real tamper detection.

IntegrityError remains the base class so existing `except IntegrityError`
call sites keep working unchanged. New code should catch the specific
subclass it cares about.
"""


class IntegrityError(Exception):
    """Base class for all state-transition/integrity failures. Kept as a
    catch-all for backward compatibility; prefer catching a subclass."""


class HashMismatchError(IntegrityError):
    """A node's hash_self does not match its own recomputed content, or
    its hash_parent does not match the parent's actual hash_self.
    Indicates tampering or corruption -- never safe to retry blindly."""


class LineageError(IntegrityError):
    """A structural lineage rule was violated (e.g. proposing against a
    parent that isn't 'active'). Distinct from a hash mismatch: the hash
    chain may be intact, but the proposed transition itself is invalid."""


class MonotonicityError(IntegrityError):
    """A node's timestamp does not strictly follow its parent's timestamp.
    Signals a manipulated or unreliable client clock."""


class ConcurrencyError(IntegrityError):
    """Another writer already claimed this parent (lost a race). This is
    the one subclass that is generally safe to retry: re-fetch the new
    active node and re-propose against it."""


class ImplausibleTimestampError(IntegrityError):
    """A node's created_at is implausibly far in the future relative to
    wall-clock time. Distinct from MonotonicityError (which only checks
    ordering relative to the parent): this is an absolute sanity bound,
    meant to stop a node from ever becoming a \"poisoned tip\" that
    permanently fails every future proposal's monotonicity check
    (see: state-pinning). Not a substitute for server-side timestamp
    assignment -- see Part 2 -- since it only catches implausible
    values, not merely-inaccurate ones."""


class PayloadTooLargeError(IntegrityError):
    """A proposed node's payload exceeds the configured size limit.
    Without this, an unbounded payload is a storage/memory/hash-compute
    DoS vector -- every descendant verification re-hashes the full
    payload, and every read reconstructs it from BYTEA."""
