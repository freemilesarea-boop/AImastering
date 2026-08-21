"""
Closed Loop Render Engine P0 - Rollback

Manages rollback when renders are rejected.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

import os
import shutil
from typing import Dict, List, Optional
from dataclasses import dataclass, field


@dataclass
class RollbackState:
    """State tracking for rollback."""
    original_path: str
    current_accepted_path: str
    candidate_paths: List[str] = field(default_factory=list)
    pass_history: List[Dict] = field(default_factory=list)


class RollbackManager:
    """
    Manages file states for rollback on rejection.

    P0 Rules:
    - Original file is NEVER modified
    - Each pass produces a candidate file
    - On rejection, candidate is discarded
    - On accept, candidate becomes new accepted state
    - Final output is always either original or last accepted
    """

    def __init__(self, output_dir: str):
        """
        Initialize rollback manager.

        Args:
            output_dir: Directory for all outputs
        """
        self.output_dir = output_dir
        self.states: Dict[str, RollbackState] = {}

        os.makedirs(output_dir, exist_ok=True)

    def register_track(
        self,
        track_id: str,
        original_path: str,
    ) -> RollbackState:
        """
        Register a track for processing.

        Args:
            track_id: Unique identifier for track
            original_path: Path to original audio file

        Returns:
            RollbackState for tracking
        """
        state = RollbackState(
            original_path=original_path,
            current_accepted_path=original_path,  # Start with original
        )
        self.states[track_id] = state
        return state

    def get_state(self, track_id: str) -> Optional[RollbackState]:
        """Get current state for a track."""
        return self.states.get(track_id)

    def record_candidate(
        self,
        track_id: str,
        pass_number: int,
        candidate_path: str,
    ) -> None:
        """
        Record a candidate render.

        Args:
            track_id: Track identifier
            pass_number: Pass number (1-indexed)
            candidate_path: Path to candidate file
        """
        state = self.states.get(track_id)
        if state is None:
            return

        state.candidate_paths.append(candidate_path)
        state.pass_history.append({
            "pass": pass_number,
            "candidate": candidate_path,
            "status": "pending",
        })

    def accept_candidate(
        self,
        track_id: str,
        pass_number: int,
        candidate_path: str,
    ) -> str:
        """
        Accept a candidate as new accepted state.

        Args:
            track_id: Track identifier
            pass_number: Pass number
            candidate_path: Path to accepted candidate

        Returns:
            Path to accepted file
        """
        state = self.states.get(track_id)
        if state is None:
            return candidate_path

        # Copy candidate to accepted location
        base = os.path.splitext(os.path.basename(candidate_path))[0]
        accepted_path = os.path.join(
            self.output_dir,
            f"{base}_pass{pass_number}_accepted.wav"
        )

        if candidate_path != accepted_path and os.path.exists(candidate_path):
            shutil.copy2(candidate_path, accepted_path)

        state.current_accepted_path = accepted_path

        # Update history
        for entry in state.pass_history:
            if entry["pass"] == pass_number:
                entry["status"] = "accepted"
                entry["accepted_path"] = accepted_path

        return accepted_path

    def reject_candidate(
        self,
        track_id: str,
        pass_number: int,
        candidate_path: str,
        cleanup: bool = False,
    ) -> str:
        """
        Reject a candidate and rollback.

        Args:
            track_id: Track identifier
            pass_number: Pass number
            candidate_path: Path to rejected candidate
            cleanup: Whether to delete the rejected file

        Returns:
            Path to rollback state (previous accepted)
        """
        state = self.states.get(track_id)
        if state is None:
            return candidate_path

        # Update history
        for entry in state.pass_history:
            if entry["pass"] == pass_number:
                entry["status"] = "rejected"

        # Optionally cleanup rejected file
        if cleanup and os.path.exists(candidate_path):
            try:
                os.remove(candidate_path)
            except OSError:
                pass

        # Return current accepted (which is unchanged)
        return state.current_accepted_path

    def finalize(
        self,
        track_id: str,
        final_name: str = "final",
    ) -> str:
        """
        Finalize track and copy to final output.

        Args:
            track_id: Track identifier
            final_name: Base name for final file

        Returns:
            Path to final output
        """
        state = self.states.get(track_id)
        if state is None:
            return ""

        source = state.current_accepted_path

        # If source is original, the final is effectively "no change"
        # Copy to final location anyway for consistency
        final_path = os.path.join(
            self.output_dir,
            f"{final_name}.wav"
        )

        if source != final_path and os.path.exists(source):
            shutil.copy2(source, final_path)
            return final_path

        return source

    def get_rollback_summary(self, track_id: str) -> Dict:
        """Get summary of rollback state."""
        state = self.states.get(track_id)
        if state is None:
            return {}

        return {
            "original_path": state.original_path,
            "current_accepted_path": state.current_accepted_path,
            "candidate_count": len(state.candidate_paths),
            "pass_history": state.pass_history,
            "is_modified": state.current_accepted_path != state.original_path,
        }

    def cleanup_candidates(
        self,
        track_id: str,
        keep_accepted: bool = True,
    ) -> int:
        """
        Clean up candidate files.

        Args:
            track_id: Track identifier
            keep_accepted: Keep accepted candidates

        Returns:
            Number of files removed
        """
        state = self.states.get(track_id)
        if state is None:
            return 0

        removed = 0
        for entry in state.pass_history:
            candidate = entry.get("candidate", "")
            accepted = entry.get("accepted_path", "")

            if entry.get("status") == "rejected":
                if os.path.exists(candidate):
                    try:
                        os.remove(candidate)
                        removed += 1
                    except OSError:
                        pass

            elif entry.get("status") == "accepted" and not keep_accepted:
                # Remove candidate but keep accepted
                if candidate != accepted and os.path.exists(candidate):
                    try:
                        os.remove(candidate)
                        removed += 1
                    except OSError:
                        pass

        return removed
