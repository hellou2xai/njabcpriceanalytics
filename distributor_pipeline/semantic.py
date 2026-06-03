"""Semantic name matching with Voyage embeddings.

Fedway pricebook names and the live catalogue names are written differently
(abbreviations, word order, vintages), so item->item matching is semantic, not
exact. We embed both sides with voyage-3 and retrieve nearest neighbours by
cosine. Master embeddings are cached on disk keyed by the name set, so reruns
are instant.
"""
import hashlib
from pathlib import Path

import numpy as np

from backend.voyage_embed import embed_documents
from . import config

CACHE_DIR = config.PROJECT_ROOT / "distributor_pipeline" / "cache"


def _norm_matrix(vecs):
    m = np.asarray(vecs, dtype=np.float32)
    n = np.linalg.norm(m, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return m / n


def embed(texts, batch=128):
    out = []
    for i in range(0, len(texts), batch):
        out.extend(embed_documents(texts[i:i + batch]))
    return _norm_matrix(out)


def embed_master(names):
    """Embed the distinct master names, caching to disk keyed by the name set."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(("\n".join(names)).encode("utf-8")).hexdigest()[:16]
    path = CACHE_DIR / f"master_emb_{key}.npz"
    if path.exists():
        return np.load(path)["m"]
    mat = embed(list(names))
    np.savez_compressed(path, m=mat)
    return mat


class SemanticIndex:
    def __init__(self, names):
        self.names = list(names)
        self.mat = embed_master(self.names)   # (N, D) unit-normalised

    def topk(self, query_vecs, k=15):
        """query_vecs: (Q, D) unit-normalised. Returns list per query of
        (name_index, cosine) for the top-k master names."""
        sims = query_vecs @ self.mat.T        # (Q, N)
        idx = np.argpartition(-sims, min(k, sims.shape[1] - 1), axis=1)[:, :k]
        out = []
        for q in range(sims.shape[0]):
            cols = idx[q]
            order = cols[np.argsort(-sims[q, cols])]
            out.append([(int(c), float(sims[q, c])) for c in order])
        return out
