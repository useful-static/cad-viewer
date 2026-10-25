#!/usr/bin/env python3
"""Write a STEP file of one flat plate with N round holes: one face with N + 1
wires, the shape whose conversion cost grows with the number of wire PAIRS.

  gen-holes-step.py N OUT.stp [--solid]

The plate is 10 mm per hole column, holes 4 mm across on a 10 mm grid. By
default it is a single face (an open shell). --solid adds the bottom face,
the four sides and each hole's cylindrical wall, which makes a closed solid.
Used to calibrate the conversion-time estimate (tests/estimate-calibrate.mjs)
and to check that the cost stays near linear in the holes.
"""
import argparse
import math


class W:
    def __init__(self):
        self.lines, self.n = [], 0

    def add(self, text):
        self.n += 1
        self.lines.append(f'#{self.n}={text};')
        return f'#{self.n}'


def plate(n, solid):
    w = W()
    cols = max(1, math.ceil(math.sqrt(n)))
    rows = math.ceil(n / cols)
    size_x, size_y, thick, r = cols * 10.0, rows * 10.0, 2.0, 2.0
    P = lambda x, y, z: w.add(f"CARTESIAN_POINT('',({x:.4f},{y:.4f},{z:.4f}))")  # noqa: E731
    D = lambda x, y, z: w.add(f"DIRECTION('',({x:.4f},{y:.4f},{z:.4f}))")  # noqa: E731
    zdir, xdir = D(0, 0, 1), D(1, 0, 0)

    def ax(p, z=zdir, x=xdir):
        return w.add(f"AXIS2_PLACEMENT_3D('',{p},{z},{x})")

    def vertex(p):
        return w.add(f"VERTEX_POINT('',{p})")

    def line_edge(a, b, pa, pb):
        (x0, y0, z0), (x1, y1, z1) = pa, pb
        length = math.dist(pa, pb)
        d = D((x1 - x0) / length, (y1 - y0) / length, (z1 - z0) / length)
        ln = w.add(f"LINE('',{P(x0, y0, z0)},{w.add(f'VECTOR(\'\',{d},{length:.4f})')})")
        return w.add(f"EDGE_CURVE('',{a},{b},{ln},.T.)")

    def loop(edges_orient):
        oes = ','.join(w.add(f"ORIENTED_EDGE('',*,*,{e},{'.T.' if o else '.F.'})") for e, o in edges_orient)
        return w.add(f"EDGE_LOOP('',({oes}))")

    corners = [(0, 0), (size_x, 0), (size_x, size_y), (0, size_y)]
    faces = []
    for z, sense in ((thick, True), (0.0, False)) if solid else ((thick, True),):
        vs = [vertex(P(x, y, z)) for x, y in corners]
        es = [line_edge(vs[i], vs[(i + 1) % 4], (*corners[i], z), (*corners[(i + 1) % 4], z)) for i in range(4)]
        bounds = [w.add(f"FACE_OUTER_BOUND('',{loop([(e, True) for e in es])},.T.)")]
        holes = []
        for k in range(n):
            cx, cy = 5.0 + 10.0 * (k % cols), 5.0 + 10.0 * (k // cols)
            v = vertex(P(cx + r, cy, z))
            circ = w.add(f"CIRCLE('',{ax(P(cx, cy, z))},{r:.4f})")
            e = w.add(f"EDGE_CURVE('',{v},{v},{circ},.T.)")
            holes.append((cx, cy, v, e))
            bounds.append(w.add(f"FACE_BOUND('',{loop([(e, True)])},.F.)"))
        plane = w.add(f"PLANE('',{ax(P(0, 0, z))})")
        faces.append(w.add(f"ADVANCED_FACE('',({','.join(bounds)}),{plane},{'.T.' if sense else '.F.'})"))
        if solid:
            if z == thick:
                top = (vs, es, holes)
            else:
                bot = (vs, es, holes)
    if solid:
        (tv, te, th), (bv, be, bh) = top, bot
        # four sides
        for i in range(4):
            j = (i + 1) % 4
            up_i = line_edge(bv[i], tv[i], (*corners[i], 0.0), (*corners[i], thick))
            up_j = line_edge(bv[j], tv[j], (*corners[j], 0.0), (*corners[j], thick))
            lp = loop([(be[i], True), (up_j, True), (te[i], False), (up_i, False)])
            (x0, y0), (x1, y1) = corners[i], corners[j]
            length = math.dist((x0, y0), (x1, y1))
            nx, ny = (y1 - y0) / length, -(x1 - x0) / length
            plane = w.add(f"PLANE('',{ax(P(x0, y0, 0), D(nx, ny, 0), D((x1 - x0) / length, (y1 - y0) / length, 0))})")
            faces.append(w.add(f"ADVANCED_FACE('',({w.add(f'FACE_OUTER_BOUND(\'\',{lp},.T.)')}),{plane},.T.)"))
        # each hole's wall: a cylinder bounded by the two circles and a seam
        for (cx, cy, v_t, e_t), (_, _, v_b, e_b) in zip(th, bh):
            seam = line_edge(v_b, v_t, (cx + r, cy, 0.0), (cx + r, cy, thick))
            lp = loop([(e_b, True), (seam, True), (e_t, False), (seam, False)])
            cyl = w.add(f"CYLINDRICAL_SURFACE('',{ax(P(cx, cy, 0))},{r:.4f})")
            faces.append(w.add(f"ADVANCED_FACE('',({w.add(f'FACE_OUTER_BOUND(\'\',{lp},.T.)')}),{cyl},.F.)"))
    # units, context, product
    lu = w.add("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))")
    au = w.add("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))")
    su = w.add("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())")
    unc = w.add(f"UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),{lu},'distance_accuracy_value','')")
    ctx = w.add(f"(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT(({unc}))"
                f"GLOBAL_UNIT_ASSIGNED_CONTEXT(({lu},{au},{su}))REPRESENTATION_CONTEXT('',''))")
    shell = w.add(f"{'CLOSED_SHELL' if solid else 'OPEN_SHELL'}('',({','.join(faces)}))")
    if solid:
        item = w.add(f"MANIFOLD_SOLID_BREP('plate',{shell})")
        rep = w.add(f"ADVANCED_BREP_SHAPE_REPRESENTATION('',({item},{ax(P(0, 0, 0))}),{ctx})")
    else:
        item = w.add(f"SHELL_BASED_SURFACE_MODEL('plate',({shell}))")
        rep = w.add(f"MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',({item},{ax(P(0, 0, 0))}),{ctx})")
    actx = w.add("APPLICATION_CONTEXT('automotive design')")
    pctx = w.add(f"PRODUCT_CONTEXT('',{actx},'mechanical')")
    prod = w.add(f"PRODUCT('plate','plate','',({pctx}))")
    pdf = w.add(f"PRODUCT_DEFINITION_FORMATION('','',{prod})")
    pdc = w.add(f"PRODUCT_DEFINITION_CONTEXT('part definition',{actx},'design')")
    pd = w.add(f"PRODUCT_DEFINITION('design','',{pdf},{pdc})")
    pds = w.add(f"PRODUCT_DEFINITION_SHAPE('','',{pd})")
    w.add(f"SHAPE_DEFINITION_REPRESENTATION({pds},{rep})")
    w.add(f"APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,{actx})")
    head = ("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('plate with holes'),'2;1');\n"
            "FILE_NAME('plate.stp','2026-10-25T00:00:00',(''),(''),'','','');\n"
            "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n")
    return head + '\n'.join(w.lines) + '\nENDSEC;\nEND-ISO-10303-21;\n'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('n', type=int)
    ap.add_argument('out')
    ap.add_argument('--solid', action='store_true')
    a = ap.parse_args()
    with open(a.out, 'w') as f:
        f.write(plate(a.n, a.solid))


if __name__ == '__main__':
    main()
