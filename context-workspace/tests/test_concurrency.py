import threading
from src.orchestration.state_orchestrator import StateTransitionOrchestrator
from src.persistence.context_persistence import ContextPersistence
from src.errors import ConcurrencyError


def test_concurrent_proposal_collision(db_config, last_node):
    persistence = ContextPersistence(db_config)
    orchestrator = StateTransitionOrchestrator(persistence)
    results = {"success": 0, "collision": 0, "error": 0}
    lock = threading.Lock()
    barrier = threading.Barrier(2)

    def attempt(payload):
        barrier.wait()
        try:
            orchestrator.process_proposal(payload, last_node)
            with lock:
                results["success"] += 1
        except ConcurrencyError:
            with lock:
                results["collision"] += 1
        except Exception:
            with lock:
                results["error"] += 1

    t1 = threading.Thread(target=attempt, args=({"data": "A"},))
    t2 = threading.Thread(target=attempt, args=({"data": "B"},))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert results["success"] == 1
    assert results["collision"] == 1
    assert results["error"] == 0
