"""Training, registering and monitoring the platform's models.

The layer's contract, in one place: a model version in `production` has weights on
disk that hash to what its training run recorded, metrics measured on sequences
strictly later than the ones it was fitted on, and a `training_datasets` row saying
whether those sequences came from the fleet, from the lake, or from the generator.
Anything that cannot be established is recorded as a refusal instead of a number.
"""

__all__ = [
    "checkpoints",
    "config",
    "continuous",
    "data",
    "distributed",
    "drift",
    "features",
    "graph",
    "graph_train",
    "lake",
    "models",
    "registry",
    "synthetic",
    "train",
]
