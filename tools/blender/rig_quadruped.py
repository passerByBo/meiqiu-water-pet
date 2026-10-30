"""
四足宠物自动绑骨脚本（Blender 内运行）

用途：给 Tripo 等 AI 生成的四足静态模型自动建一副和煤球代码关节一致的骨架，并自动绑定权重。
骨骼命名和层级对应 src/pet/BlackCatModel.ts / ShibaModel.ts：
    hips → chest → neck → head
    chest → 前腿（upper → knee），hips → 后腿（upper → knee）
    hips → tail_0 → tail_1 → ...

前提（生成模型时就要满足，见 docs/3D模型制作流程.md）：
    - 四脚着地、脚底贴地（z=0），脸朝 -Y（glTF 导入后 Tripo 模型默认如此）
    - 四条腿分开，尾巴和身体分开

用法（Blender MCP 或 Blender 的脚本编辑器里）：
    exec(open(r"D:/woke/homework/gongju/tools/blender/rig_quadruped.py", encoding="utf-8").read())
    rig_quadruped("黑猫_原始", tail_bone_count=4)
"""
import bmesh
import bpy
import heapq
import mathutils

Vector = mathutils.Vector


def _merge_split_vertices(mesh_object, distance=0.0005):
    """glTF 导入会在 UV 接缝处把顶点拆开，导致网格"断开"，自动权重会失败。
    这里合并重合顶点（UV 存在面角上，合并顶点不会丢 UV）。"""
    bm = bmesh.new()
    bm.from_mesh(mesh_object.data)
    before = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=distance)
    bm.to_mesh(mesh_object.data)
    bm.free()
    mesh_object.data.update()
    return before, len(mesh_object.data.vertices)


def _find_feet(points, sole_height):
    """取最贴地的"脚底"顶点，按平面位置聚成 4 类（k-means），返回 左前/右前/左后/右后 四个脚底中心。
    不能直接按 x 正负分组：AI 模型常常不对称（某条腿往里迈）。"""
    soles = [p for p in points if p.z < sole_height]
    sorted_y = sorted(p.y for p in soles)
    sorted_x = sorted(p.x for p in soles)
    middle_y, middle_x = sorted_y[len(sorted_y) // 2], sorted_x[len(sorted_x) // 2]
    # 用四个象限的平均点做初始中心，结果稳定
    centers = []
    for is_front in (True, False):
        for is_left in (True, False):
            chosen = [p for p in soles if (p.y < middle_y) == is_front and (p.x < middle_x) == is_left] or soles
            centers.append(sum(chosen, Vector()) / len(chosen))
    for _ in range(30):
        buckets = [[] for _ in centers]
        for p in soles:
            nearest = min(range(4), key=lambda i: (p.xy - centers[i].xy).length)
            buckets[nearest].append(p)
        centers = [sum(b, Vector()) / len(b) if b else centers[i] for i, b in enumerate(buckets)]
    # 按前后、左右重新命名（脸朝 -Y，所以 y 小的是前；x 小的是左）
    front_pair = sorted(sorted(centers, key=lambda c: c.y)[:2], key=lambda c: c.x)
    back_pair = sorted(sorted(centers, key=lambda c: c.y)[2:], key=lambda c: c.x)
    return {
        "frontLeft": front_pair[0], "frontRight": front_pair[1],
        "backLeft": back_pair[0], "backRight": back_pair[1],
    }


def _band_center_x(points, y_low, y_high, z_low, z_high):
    band = [p for p in points if y_low < p.y < y_high and z_low < p.z < z_high]
    return (min(p.x for p in band) + max(p.x for p in band)) / 2 if band else 0.0


def _trace_tail(mesh_object, tail_tip, stop_y, segment_count, base_height, tail_base=None):
    """从尾巴尖沿网格表面做测地距离（Dijkstra），按距离分段求每段顶点的中心，得到尾巴中心线。
    只在 y > stop_y（后脚以后）的区域里走。
    尾根判断：中心线从尾尖往下，第一次低于 base_height（背部高度）的地方。
    这个规则只适合竖起来的尾巴；垂下来或贴地的尾巴请直接传 tail_base 指定尾根位置。
    （试过"截面半径突然变大""中心离表面距离突变"两种判断，在 AI 模型上都不可靠：
    尾尖是个圆球，测地环不规整；进入屁股后环中心贴着表面走，数值是渐变的。）"""
    bm = bmesh.new()
    bm.from_mesh(mesh_object.data)
    bm.verts.ensure_lookup_table()
    start = min(bm.verts, key=lambda v: (v.co - tail_tip).length)
    distance = {start.index: 0.0}
    queue = [(0.0, start.index)]
    while queue:
        current_distance, index = heapq.heappop(queue)
        if current_distance > distance.get(index, 1e9):
            continue
        vertex = bm.verts[index]
        for edge in vertex.link_edges:
            other = edge.other_vert(vertex)
            if other.co.y < stop_y:
                continue
            new_distance = current_distance + edge.calc_length()
            if new_distance < distance.get(other.index, 1e9):
                distance[other.index] = new_distance
                heapq.heappush(queue, (new_distance, other.index))
    positions = {index: bm.verts[index].co.copy() for index in distance}
    bm.free()

    # 按测地距离每 2cm 一段，求中心线
    bin_size = 0.02
    centerline = []
    for step in range(int(max(distance.values()) / bin_size) + 1):
        ring = [positions[i] for i, d in distance.items() if step * bin_size <= d < (step + 1) * bin_size]
        if len(ring) >= 3:
            centerline.append((step * bin_size, sum(ring, Vector()) / len(ring)))

    if tail_base is not None:
        base_distance = min(centerline, key=lambda item: (item[1] - tail_base).length)[0]
    else:
        base_distance = next((d for d, c in centerline if c.z < base_height), centerline[-1][0])

    # 从尾根到尾尖取 segment_count + 1 个关节点
    joints = []
    for k in range(segment_count + 1):
        target = base_distance * (1 - k / segment_count)
        joints.append(min(centerline, key=lambda item: abs(item[0] - target))[1].copy())
    if tail_base is not None:
        joints[0] = tail_base.copy()
    joints[-1] = tail_tip.copy()
    return joints


def analyze_quadruped(mesh_object):
    """从网格几何估算各关节位置，返回字典（世界坐标，模型需未旋转缩放或已应用变换）。"""
    points = [v.co.copy() for v in mesh_object.data.vertices]
    height = max(p.z for p in points)
    nose = min(points, key=lambda p: p.y)
    feet = _find_feet(points, height * 0.06)

    front_y = (feet["frontLeft"].y + feet["frontRight"].y) / 2
    back_y = (feet["backLeft"].y + feet["backRight"].y) / 2
    # 身体中段的上下范围 → 躯干中心高度
    middle = [p for p in points if abs(p.y - (front_y + back_y) / 2) < 0.06]
    belly_z, back_z = min(p.z for p in middle), max(p.z for p in middle)
    torso_z = (belly_z + back_z) / 2
    torso_x = _band_center_x(points, front_y, back_y, belly_z, back_z)

    # 尾巴尖：身体后端以后最高的点
    rear_limit = back_y + (max(p.y for p in points) - back_y) * 0.3
    tail_tip = max((p for p in points if p.y > rear_limit), key=lambda p: p.z)

    # 头：鼻尖到前脚之间，取头部上下范围的中点
    head_y = nose.y + (front_y - nose.y) * 0.45
    head_band = [p for p in points if abs(p.y - head_y) < 0.04 and p.z > torso_z]
    head_z = (min(p.z for p in head_band) + max(p.z for p in head_band)) / 2
    head_x = _band_center_x(points, head_y - 0.04, head_y + 0.04, torso_z, height)

    return {
        "height": height, "nose": nose, "feet": feet, "tail_tip": tail_tip,
        "front_y": front_y, "back_y": back_y, "belly_z": belly_z, "back_z": back_z,
        "torso_x": torso_x, "torso_z": torso_z,
        "head": Vector((head_x, head_y, head_z)),
    }


def rig_quadruped(mesh_name, tail_bone_count=4, armature_name=None, tail_base=None):
    """tail_bone_count=0 表示没有尾巴（比如仓鼠）；tail_base 可手动指定尾根坐标（Vector）。"""
    mesh_object = bpy.data.objects[mesh_name]
    bpy.ops.object.select_all(action="DESELECT")
    mesh_object.select_set(True)
    bpy.context.view_layer.objects.active = mesh_object
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    before, after = _merge_split_vertices(mesh_object)
    info = analyze_quadruped(mesh_object)
    feet, torso_z = info["feet"], info["torso_z"]

    hips_head = Vector((info["torso_x"], info["back_y"], torso_z))
    chest_head = Vector((info["torso_x"], info["front_y"], torso_z))
    neck_head = chest_head.lerp(info["head"], 0.35)
    neck_head.z = max(neck_head.z, torso_z + (info["back_z"] - torso_z) * 0.5)
    head_top = info["head"] + Vector((0, 0, (info["height"] - info["head"].z) * 0.6))
    tail_joints = []
    if tail_bone_count > 0:
        tail_joints = _trace_tail(mesh_object, info["tail_tip"], info["back_y"], tail_bone_count,
                                  base_height=info["back_z"] * 0.9, tail_base=tail_base)

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

    # 脊柱：hips 是根骨骼，从屁股指向胸口；chest 从胸口指向脖子
    add_bone("hips", hips_head, chest_head)
    add_bone("chest", chest_head, neck_head, "hips", connect=True)
    add_bone("neck", neck_head, info["head"], "chest", connect=True)
    add_bone("head", info["head"], head_top, "neck", connect=True)

    # 腿：肩/胯在躯干中心高度、脚的正上方（稍往身体中线收），膝盖在中间
    for leg_name, foot in feet.items():
        parent = "chest" if leg_name.startswith("front") else "hips"
        top = Vector((foot.x + (info["torso_x"] - foot.x) * 0.25, foot.y, torso_z))
        sole = Vector((foot.x, foot.y, 0.0))
        knee = top.lerp(sole, 0.5)
        knee.y -= 0.01 if leg_name.startswith("back") else -0.01  # 给膝盖一点预弯，IK/旋转方向更自然
        add_bone(leg_name + "_upper", top, knee, parent)
        add_bone(leg_name + "_knee", knee, sole, leg_name + "_upper", connect=True)

    # 尾巴：从尾根到尾尖
    parent = "hips"
    for index in range(tail_bone_count):
        add_bone(f"tail_{index}", tail_joints[index], tail_joints[index + 1], parent, connect=index > 0)
        parent = f"tail_{index}"

    bpy.ops.object.mode_set(mode="OBJECT")

    # 自动权重（骨骼热量法）
    bpy.ops.object.select_all(action="DESELECT")
    mesh_object.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")

    # 检查：没有被任何骨骼影响的顶点（自动权重失败时会很多）
    groups = {g.index: g.name for g in mesh_object.vertex_groups}
    unweighted = sum(1 for v in mesh_object.data.vertices if not any(g.weight > 0.01 for g in v.groups))
    report = {
        "合并顶点": f"{before} -> {after}",
        "脚": {k: tuple(round(c, 3) for c in v) for k, v in feet.items()},
        "躯干中心": (round(info["torso_x"], 3), round(torso_z, 3)),
        "头": tuple(round(c, 3) for c in info["head"]),
        "尾巴关节": [tuple(round(c, 3) for c in j) for j in tail_joints],
        "骨骼数": len(armature_data.bones),
        "顶点组数": len(groups),
        "没有权重的顶点": unweighted,
    }
    return armature, report
