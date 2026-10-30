"""Build deterministic fixtures with exhaustive reference solvers, no model calls."""
import itertools
import json
from pathlib import Path

cases = []
def add(case_id, prompt, expected):
    cases.append(dict(id=case_id, prompt=prompt + " Responde únicamente el número entero, sin explicación.", expected=str(expected)))

items = [(3, 8), (4, 10), (5, 14), (7, 19), (8, 20), (9, 25), (2, 5)]
opt = max(sum(v for (_, v), yes in zip(items, mask) if yes) for mask in itertools.product([0, 1], repeat=len(items)) if sum(w for (w, _), yes in zip(items, mask) if yes) <= 17)
add("knapsack", f"Mochila 0/1, capacidad 17, objetos (peso,valor): {items}. Cada objeto se puede usar una sola vez. ¿Valor total máximo?", opt)

jobs = [(0, 3, 8), (1, 4, 9), (3, 5, 6), (4, 7, 13), (5, 8, 11), (7, 9, 7), (8, 11, 12), (9, 12, 15)]
opt = 0
for mask in itertools.product([0, 1], repeat=len(jobs)):
    chosen = sorted(j for j, yes in zip(jobs, mask) if yes)
    if all(a[1] <= b[0] for a, b in zip(chosen, chosen[1:])):
        opt = max(opt, sum(j[2] for j in chosen))
add("weighted-intervals", f"Trabajos (inicio,fin,beneficio): {jobs}. Intervalos [inicio,fin); puedes elegir trabajos sin solapamiento. ¿Beneficio máximo?", opt)

cost = [[9, 2, 7, 8, 6], [6, 4, 3, 7, 5], [5, 8, 1, 8, 3], [7, 6, 9, 4, 2], [8, 5, 2, 9, 7]]
opt = min(sum(cost[i][j] for i, j in enumerate(perm)) for perm in itertools.permutations(range(5)))
add("assignment", f"Asigna una columna distinta a cada fila de esta matriz de costos 5x5, minimizando la suma: {cost}. ¿Costo mínimo?", opt)

obstacles = {(1, 2), (2, 2), (3, 4), (4, 1), (5, 5)}
count = 0
for down in itertools.combinations(range(12), 6):
    row = col = 0
    valid = True
    for step in range(12):
        row += step in down
        col += step not in down
        if (row, col) in obstacles:
            valid = False
            break
    count += valid
add("grid-paths", f"Cuadrícula con coordenadas fila,columna de 0 a 6. Desde (0,0) a (6,6), sólo puedes bajar o ir a la derecha. Celdas bloqueadas: {sorted(obstacles)}. ¿Cuántos caminos válidos hay?", count)

edges = [(0, 3), (1, 3), (1, 4), (2, 4), (3, 5), (4, 5), (4, 6)]
count = sum(all(perm.index(a) < perm.index(b) for a, b in edges) for perm in itertools.permutations(range(7)))
add("topological-orders", f"Grafo dirigido de nodos 0 a 6 y aristas {edges}. ¿Cuántos órdenes topológicos distintos tiene?", count)

numbers = [2, 3, 5, 7, 11, 13, 17, 19, 23]
count = sum(sum(n for n, yes in zip(numbers, mask) if yes) == 41 for mask in itertools.product([0, 1], repeat=len(numbers)))
add("subset-count", f"Lista {numbers}. ¿Cuántos subconjuntos distintos suman exactamente 41? Cada elemento puede usarse como máximo una vez; el orden no importa.", count)

path = Path(__file__).resolve().parent.parent / "test/fixtures/auto-routing/reasoning-oracles.json"
path.write_text(json.dumps(cases, indent=2, ensure_ascii=False) + "\n")
print(f"Generated {len(cases)} oracle-verified cases")
