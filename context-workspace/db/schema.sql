CREATE TABLE context_nodes (
    node_id UUID PRIMARY KEY,
    parent_id UUID UNIQUE,
    version_index INTEGER NOT NULL,
    hash_self TEXT NOT NULL,
    hash_parent TEXT,
    raw_payload BYTEA NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES context_nodes(node_id)
);

CREATE UNIQUE INDEX idx_single_root ON context_nodes ((1)) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX idx_single_active_node ON context_nodes ((1)) WHERE status = 'active';
CREATE INDEX idx_active_status ON context_nodes (status) WHERE status = 'active';

CREATE OR REPLACE FUNCTION protect_immutable_nodes() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Immutability Violation: Registry records cannot be deleted.';
    END IF;

    IF NEW.node_id       IS DISTINCT FROM OLD.node_id
       OR NEW.parent_id      IS DISTINCT FROM OLD.parent_id
       OR NEW.version_index  IS DISTINCT FROM OLD.version_index
       OR NEW.hash_self      IS DISTINCT FROM OLD.hash_self
       OR NEW.hash_parent    IS DISTINCT FROM OLD.hash_parent
       OR NEW.raw_payload    IS DISTINCT FROM OLD.raw_payload
       OR NEW.created_at     IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'Immutability Violation: only the status column may change on an existing node, and no other field.';
    END IF;

    IF OLD.status = 'archived' THEN
        RAISE EXCEPTION 'Immutability Violation: node % is already archived and cannot change status again.', OLD.node_id;
    END IF;

    IF NOT (OLD.status = 'active' AND NEW.status = 'archived') THEN
        RAISE EXCEPTION 'Immutability Violation: the only permitted status transition is active -> archived.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_nodes
    BEFORE UPDATE OR DELETE ON context_nodes
    FOR EACH ROW EXECUTE FUNCTION protect_immutable_nodes();
