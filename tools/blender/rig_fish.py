"""
金鱼自动绑骨脚本（Blender 内运行）

用途：给 Tripo 等 AI 生成的金鱼静态模型建一串"游泳骨架"并自动绑定权重。
骨骼（名字给 src/pet/models/GltfFishModel.ts 用）：
    body（根，身体中段）→ head（往前指到嘴）
    body → spine → tail_0 → tail_1（往后到尾鳍末端，游动时一节节慢半拍地摆，形成 S 形波浪）
    body → fin_left / fin_right（胸鳍，一直扇）

前提（生成模型时就要满足，见 docs/3D模型制作流程.md）：
    - 身体横着、脸朝 -Y、侧身游的姿势
    - 尾鳍、胸鳍是和身体分开的薄片

用法：
    exec(open(r"D:/woke/homework/gongju/tools/blender/rig_fish.py", encoding="utf-8").read())
    armature, report = rig_fish("金鱼")
"""
import bmesh
import bpy
import mathutils

Vector = mathutils.Vector


def _merge_split_vertices(mesh_object, distance=0.0005):
    """glTF 导入会在 UV 接缝处把顶点拆开，导致网格"断开"，自动权重会失败"""
    bm = bmesh.new()
    bm.from_mesh(mesh_object.data)
    before = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=distance)
    bm.to_mesh(mesh_object.data)
    bm.free()
    return before, len(mesh_object.data.vertices)


def _slice_center(points, y, half_width=0.025):
    """y 附近一片截面的中心（x 用左右中点，z 用上下中点）"""
    band = [p for p in points if abs(p.y - y) < half_width]
    if not band:
        return None
    return Vector(((min(p.x for p in band) + max(p.x for p in band)) / 2, y,
                   (min(p.z for p in band) + max(p.z for p in band)) / 2))


def analyze_fish(mesh_object):
    points = [v.co.copy() for v in mesh_object.data.vertices]
    front_y = min(p.y for p in points)
    back_y = max(p.y for p in points)
    # 身体和尾鳍的分界：截面左右宽度第一次小于最宽处 25% 的地方（尾柄），从身体中段往后找
    widths = []
    step = (back_y - front_y) / 40
    for k in range(41):
        y = front_y + k * step
        band = [p for p in points if abs(p.y - y) < step]
        widths.append((y, (max(p.x for p in band) - min(p.x for p in band)) if band else 0))
    widest_y, widest = max(widths, key=lambda item: item[1])
    peduncle_y = next((y for y, w in widths if y > widest_y and w < widest * .25), front_y + (back_y - front_y) * .65)
    # 身体中心线用"去掉胸鳍"的截面：只取靠近中线（|x| 小于身体半宽）的点
    body_half_width = min(w for y, w in widths if widest_y - .05 < y < peduncle_y) / 2 if widest else .1
    core = [p for p in points if abs(p.x) <= max(body_half_width, .05)]
    # 胸鳍：离中线最远的那些点（左右各一团）
    side_points = sorted(points, key=lambda p: -abs(p.x))[:max(20, len(points) // 60)]
    fins = {}
    for name, sign in (("fin_left", -1), ("fin_right", 1)):
        group = [p for p in side_points if p.x * sign > 0]
        fins[name] = sum(group, Vector()) / len(group) if group else None
    return {
        "front_y": front_y, "back_y": back_y, "peduncle_y": peduncle_y,
        "core": core, "fins": fins, "body_half_width": body_half_width,
    }


def rig_fish(mesh_name, armature_name=None):
    mesh_object = bpy.data.objects[mesh_name]
    bpy.ops.object.select_all(action="DESELECT")
    mesh_object.select_set(True)
    bpy.context.view_layer.objects.active = mesh_object
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    before, after = _merge_split_vertices(mesh_object)
    info = analyze_fish(mesh_object)
    core, front_y, back_y, peduncle_y = info["core"], info["front_y"], info["back_y"], info["peduncle_y"]
    body_length = peduncle_y - front_y

    # 中心线上的关节：嘴 → 头后 → 身体中段 → 尾柄 → 尾鳍中段 → 尾鳍末端
    def center(y):
        return _slice_center(core, y) or Vector((0, y, 0))
    mouth = center(front_y + .02)
    head_back = center(front_y + body_length * .35)
    body_middle = center(front_y + body_length * .7)
    peduncle = center(peduncle_y)
    tail_middle = center(peduncle_y + (back_y - peduncle_y) * .5)
    tail_end = center(back_y - .01)
    # 尾鳍是竖着展开的大片，中心线高度用尾柄的高度，不然骨头会偏到尾鳍上下边缘
    tail_middle.z = tail_end.z = peduncle.z

    armature_data = bpy.data.armatures.new((armature_name or mesh_name) + "_骨架")
    armature = bpy.data.objects.new(armature_name or (mesh_name + "_骨架"), armature_data)
    bpy.context.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    bones = armature_data.edit_bones

    def add_bone(name, head, tail, parent=None, connect=False):
        bone = bones.new(name)
        bone.head, bone.tail = head, tail
        if parent:
            bone.parent = bones[parent]
            bone.use_connect = connect
        return bone

    add_bone("body", head_back, body_middle)
    add_bone("head", head_back, mouth, "body")
    add_bone("spine", body_middle, peduncle, "body", connect=True)
    add_bone("tail_0", peduncle, tail_middle, "spine", connect=True)
    add_bone("tail_1", tail_middle, tail_end, "tail_0", connect=True)
    for name, tip in info["fins"].items():
        if tip is None:
            continue
        root = Vector((info["body_half_width"] * (1 if tip.x > 0 else -1) * .8, tip.y, tip.z))
        add_bone(name, root, tip, "body")
    bpy.ops.object.mode_set(mode="OBJECT")

    bpy.ops.object.select_all(action="DESELECT")
    mesh_object.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")

    unweighted = sum(1 for v in mesh_object.data.vertices if not any(g.weight > 0.01 for g in v.groups))
    report = {
        "合并顶点": f"{before} -> {after}",
        "尾柄 y": round(peduncle_y, 3),
        "中心线": [tuple(round(c, 3) for c in p) for p in (mouth, head_back, body_middle, peduncle, tail_middle, tail_end)],
        "胸鳍": {k: tuple(round(c, 3) for c in v) if v else None for k, v in info["fins"].items()},
        "骨骼": [b.name for b in armature_data.bones],
        "没有权重的顶点": unweighted,
    }
    return armature, report
