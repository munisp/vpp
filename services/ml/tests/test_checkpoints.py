import os

import pytest
import torch

from vppml import checkpoints, features, models


def stored(tmp_path, **overrides):
    model = models.AssetForecaster(
        models.ForecasterConfig(features=len(features.FEATURE_NAMES), lookback=4, horizon=2, hidden=8)
    )
    payload = {
        "directory": str(tmp_path),
        "filename": "asset_v1.pt",
        "kind": models.AssetForecaster.kind,
        "hyperparameters": models.ForecasterConfig(
            features=len(features.FEATURE_NAMES), lookback=4, horizon=2, hidden=8
        ).as_dict(),
        "feature_spec": features.FeatureSpec(lookback=4, horizon=2, interval_minutes=15).as_dict(),
        "provenance": {"origin": "synthetic", "seed": 1},
    }
    payload.update(overrides)
    return model, checkpoints.save(model, **payload)


def test_a_saved_checkpoint_is_on_disk_and_hashes_to_what_was_recorded(tmp_path):
    _, result = stored(tmp_path)
    assert os.path.exists(result.path)
    assert result.bytes_written == os.path.getsize(result.path)
    assert result.digest == checkpoints.digest_file(result.path)
    assert len(result.digest) == 64


def test_the_same_weights_hash_the_same_and_different_weights_do_not(tmp_path):
    torch.manual_seed(3)
    _, first = stored(tmp_path, filename="a.pt")
    torch.manual_seed(3)
    _, again = stored(tmp_path, filename="b.pt")
    torch.manual_seed(4)
    _, other = stored(tmp_path, filename="c.pt")
    assert first.digest == again.digest
    assert first.digest != other.digest


def test_a_missing_artifact_is_refused_not_treated_as_an_untrained_model(tmp_path):
    _, result = stored(tmp_path)
    os.remove(result.path)
    with pytest.raises(checkpoints.CheckpointError, match="does not exist"):
        checkpoints.load(result.path, result.digest)


def test_a_tampered_artifact_is_refused(tmp_path):
    """The digest is the whole point: altered weights must not load as the trained
    model whose metrics the registry advertises."""
    _, result = stored(tmp_path)
    with open(result.path, "r+b") as handle:
        handle.seek(os.path.getsize(result.path) - 8)
        handle.write(b"\x00\x01\x02\x03")
    with pytest.raises(checkpoints.CheckpointError, match="digests to"):
        checkpoints.load(result.path, result.digest)


def test_a_truncated_artifact_is_refused(tmp_path):
    _, result = stored(tmp_path)
    with open(result.path, "r+b") as handle:
        handle.truncate(result.bytes_written // 2)
    with pytest.raises(checkpoints.CheckpointError, match="digests to"):
        checkpoints.load(result.path, result.digest)


def test_serving_rebuilds_the_recorded_architecture_in_eval_mode(tmp_path):
    original, result = stored(tmp_path)
    spec_digest = features.FeatureSpec(lookback=4, horizon=2, interval_minutes=15).digest()
    model, payload = checkpoints.load_for_serving(
        result.path, result.digest, feature_spec_digest=spec_digest
    )
    assert isinstance(model, models.AssetForecaster)
    assert model.training is False
    assert payload["provenance"]["origin"] == "synthetic"
    x = torch.zeros(1, 4, len(features.FEATURE_NAMES))
    with torch.no_grad():
        assert torch.allclose(model(x), original.eval()(x))


def test_serving_refuses_a_checkpoint_built_for_different_features(tmp_path):
    """Feature order is part of the contract; loading weights against a different
    layout would produce confident nonsense rather than an error."""
    _, result = stored(tmp_path)
    other = features.FeatureSpec(lookback=6, horizon=2, interval_minutes=15).digest()
    with pytest.raises(checkpoints.CheckpointError, match="feature spec"):
        checkpoints.load_for_serving(result.path, result.digest, feature_spec_digest=other)


def test_a_checkpoint_records_the_framework_version_that_produced_it(tmp_path):
    _, result = stored(tmp_path)
    payload = checkpoints.load(result.path, result.digest)
    assert payload["torch_version"] == torch.__version__
    assert payload["kind"] == models.AssetForecaster.kind


def test_saving_refuses_a_kind_it_cannot_rebuild(tmp_path):
    model = torch.nn.Linear(2, 2)
    with pytest.raises(checkpoints.CheckpointError, match="cannot be rebuilt"):
        checkpoints.save(
            model,
            directory=str(tmp_path),
            filename="x.pt",
            kind="hand_rolled",
            hyperparameters={},
            feature_spec={},
            provenance={},
        )


class Sneaky:
    """Stands in for whatever an attacker would rather have unpickled."""

    def __init__(self) -> None:
        self.value = 1


def test_a_foreign_pickled_file_is_refused_rather_than_executed(tmp_path):
    """A digest match proves the bytes are the recorded ones, not that they are safe.
    Checkpoints are read with `weights_only=True`, so a file carrying arbitrary
    pickled objects cannot load however well it hashes."""
    path = str(tmp_path / "foreign.pt")
    torch.save({"kind": "asset_forecaster", "state_dict": {}, "extra": Sneaky()}, path)
    digest = checkpoints.digest_file(path)
    with pytest.raises(checkpoints.CheckpointError):
        checkpoints.load(path, digest)


def test_a_checkpoint_without_metadata_is_refused(tmp_path):
    path = str(tmp_path / "bare.pt")
    torch.save({"state_dict": {"w": torch.zeros(2)}}, path)
    with pytest.raises(checkpoints.CheckpointError, match="not a checkpoint this service wrote"):
        checkpoints.load(path, checkpoints.digest_file(path))
