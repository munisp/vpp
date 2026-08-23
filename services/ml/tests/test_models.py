from datetime import datetime

import pytest
import torch

from vppml import features, graph, models, synthetic
from vppml.features import FeatureSpec
from vppml.train import TrainingConfig, fit


START = datetime(2026, 3, 2, 0, 0, 0)


def sequences(hours=480, lookback=12, horizon=3):
    fleet = synthetic.build_fleet(31, solar_sites=4, battery_sites=2, meter_sites=4)
    columns = synthetic.generate(fleet, start=START, hours=hours)
    return (
        features.build_sequences(
            columns,
            FeatureSpec(lookback=lookback, horizon=horizon, interval_minutes=15),
            asset_kinds=synthetic.asset_kinds(fleet),
            asset_capacities=synthetic.asset_capacities(fleet),
        ),
        fleet,
    )


def test_the_forecaster_is_a_torch_module_with_learnable_parameters():
    model = models.AssetForecaster(
        models.ForecasterConfig(features=len(features.FEATURE_NAMES), lookback=12, horizon=3)
    )
    assert isinstance(model, torch.nn.Module)
    assert models.parameter_count(model) > 10_000
    assert all(parameter.requires_grad for parameter in model.parameters())


def test_training_reduces_validation_loss_and_beats_predicting_the_last_value():
    """The check that the loop actually learns: gradients move the weights somewhere
    better than the trivial forecast, on sequences it never saw."""
    built, _ = sequences()
    x_train, y_train, x_val, y_val, _ = features.time_split(built)
    torch.manual_seed(0)
    model = models.AssetForecaster(
        models.ForecasterConfig(features=len(features.FEATURE_NAMES), lookback=12, horizon=3, hidden=64)
    )
    model.eval()
    with torch.no_grad():
        before = float(
            torch.nn.HuberLoss(delta=0.1)(
                model(torch.from_numpy(x_val)), torch.from_numpy(y_val)
            ).item()
        )
    result = fit(
        model,
        x_train=x_train,
        y_train=y_train,
        x_val=x_val,
        y_val=y_val,
        training=TrainingConfig(epochs=60, batch_size=128, lookback=12, horizon=3, patience=15),
    )
    assert result.epochs_ran >= 1
    assert result.val_loss < before

    with torch.no_grad():
        predicted = model(torch.from_numpy(x_val))
    scale = torch.from_numpy(built.scale[len(x_train) :]).reshape(-1, 1)
    actual = torch.from_numpy(y_val)
    trained_mae = float(((predicted - actual) * scale).abs().mean().item())
    persistence = torch.from_numpy(x_val)[:, -1, 0].reshape(-1, 1)
    persistence_mae = float(((persistence - actual) * scale).abs().mean().item())
    assert trained_mae < persistence_mae


def test_weights_actually_change_during_training():
    built, _ = sequences(hours=120)
    x_train, y_train, x_val, y_val, _ = features.time_split(built)
    model = models.AssetForecaster(
        models.ForecasterConfig(features=len(features.FEATURE_NAMES), lookback=12, horizon=3, hidden=16)
    )
    original = {key: value.detach().clone() for key, value in model.state_dict().items()}
    fit(
        model,
        x_train=x_train,
        y_train=y_train,
        x_val=x_val,
        y_val=y_val,
        training=TrainingConfig(epochs=2, batch_size=64, lookback=12, horizon=3),
    )
    assert any(
        not torch.allclose(original[key], value) for key, value in model.state_dict().items()
    )


def test_the_best_epoch_weights_are_kept_not_the_last():
    built, _ = sequences(hours=160)
    x_train, y_train, x_val, y_val, _ = features.time_split(built)
    model = models.AssetForecaster(
        models.ForecasterConfig(features=len(features.FEATURE_NAMES), lookback=12, horizon=3, hidden=16)
    )
    result = fit(
        model,
        x_train=x_train,
        y_train=y_train,
        x_val=x_val,
        y_val=y_val,
        training=TrainingConfig(epochs=8, batch_size=64, lookback=12, horizon=3, patience=2),
    )
    with torch.no_grad():
        final = float(
            torch.nn.HuberLoss(delta=0.1)(
                model(torch.from_numpy(x_val)), torch.from_numpy(y_val)
            ).item()
        )
    assert final == pytest.approx(result.val_loss, rel=1e-4)


def test_the_gnn_passes_messages_along_the_topology():
    """A node's output must depend on its neighbours' inputs, or the graph is
    decoration: change only node 0's history and node 1 must move too."""
    model = models.TopologyGNN(
        models.GNNConfig(features=len(graph.GRAPH_FEATURE_NAMES), lookback=6, horizon=2, hidden=8)
    )
    model.eval()
    node_ids = [1, 2, 3]
    adjacency = models.normalised_adjacency(node_ids, [(1, 2), (2, 3)])
    x = torch.zeros(1, 3, 6, len(graph.GRAPH_FEATURE_NAMES))
    with torch.no_grad():
        base = model(x, adjacency)
        x[0, 0, :, 0] = 1.0
        moved = model(x, adjacency)
    assert not torch.allclose(base[0, 1], moved[0, 1])


def test_an_isolated_node_is_unaffected_by_the_rest_of_the_graph():
    model = models.TopologyGNN(
        models.GNNConfig(features=len(graph.GRAPH_FEATURE_NAMES), lookback=6, horizon=2, hidden=8)
    )
    model.eval()
    adjacency = models.normalised_adjacency([1, 2, 3], [(1, 2)])
    x = torch.zeros(1, 3, 6, len(graph.GRAPH_FEATURE_NAMES))
    with torch.no_grad():
        base = model(x, adjacency)
        x[0, 0, :, 0] = 5.0
        moved = model(x, adjacency)
    assert torch.allclose(base[0, 2], moved[0, 2], atol=1e-6)


def test_an_edge_outside_the_graph_is_refused_not_dropped():
    with pytest.raises(ValueError, match="outside the graph"):
        models.normalised_adjacency([1, 2], [(1, 9)])


def test_adjacency_is_symmetric_and_includes_self_loops():
    adjacency = models.normalised_adjacency([1, 2], [(1, 2)])
    assert torch.allclose(adjacency, adjacency.T)
    assert float(adjacency[0, 0]) > 0


def test_a_model_can_be_rebuilt_from_its_recorded_hyperparameters():
    config = models.GNNConfig(features=6, lookback=4, horizon=2, hidden=8, passes=1)
    rebuilt = models.build(models.TopologyGNN.kind, config.as_dict())
    assert isinstance(rebuilt, models.TopologyGNN)
    with pytest.raises(ValueError, match="unknown model kind"):
        models.build("linear_regression", {})
