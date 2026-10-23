// 猫咪窗口与行为的常量（单位：逻辑像素，即按屏幕缩放比例换算后的像素）

/** 猫咪窗口大小：下面放猫的 3D 画布，上面留给对话气泡 */
export const PET_WINDOW_WIDTH = 360;
export const PET_WINDOW_HEIGHT = 380;
export const CAT_CANVAS_SIZE = 240;
export const CAT_CANVAS_LEFT = (PET_WINDOW_WIDTH - CAT_CANVAS_SIZE) / 2;
export const CAT_CANVAS_TOP = PET_WINDOW_HEIGHT - CAT_CANVAS_SIZE - 6;

/**
 * 猫咪大小（设置里可调，默认 75%）。3D 猫以脚底为中心缩放，
 * 所有和猫身体大小有关的距离（占地、探头深度、拎起来的偏移……）都要乘上它，用 catPixels() 换算
 */
export const catDisplay = { scale: .75 };
export const catPixels = (value: number): number => value * catDisplay.scale;

export const GRID_CELL_SIZE = 24;                 // 空闲区域网格大小
export const CAT_FOOTPRINT = { halfWidth: 66, heightAbove: 118, depthBelow: 12 }; // 猫在桌面上占的区域（100% 大小时，相对脚底中心点）
export const OBSTACLE_MARGIN = 6;                 // 与窗口保持的距离
export const WALK_SPEED = 62;                     // 散步速度（像素/秒）
export const SNEAK_SPEED = 40;                    // 蹑手蹑脚的速度
export const RUN_SPEED = 210;                     // 奔跑速度
export const STRIDE_LENGTH = 46;                  // 一个完整步伐对应的移动距离，避免"滑步"
export const ACTIVE_FPS = 30;                     // 正常渲染帧率
export const SLEEP_FPS = 10;                      // 睡觉时降低帧率省电
export const SCARE_CURSOR_SPEED = 1400;           // 鼠标冲过来超过这个速度会吓到猫（像素/秒）
export const PEEK_DUCK_CURSOR_SPEED = 900;        // 偷看时鼠标冲过来超过这个速度就缩回去
// 下面三个是 100% 大小时的像素数，使用时要经过 catPixels() 换算
export const PEEK_SIDE_DEPTH = 52;                // 从窗口侧边探头时，脚底藏在边线内多少像素
export const PEEK_UP_DEPTH = 40;                  // 从上边沿探头时，脚底藏在边线下多少像素
export const DRAG_GROUND_OFFSET = 105;            // 拎着后颈时，脚底在鼠标下方多少像素
export const REMINDER_BUBBLE_TIMEOUT_MS = 60_000; // 提醒气泡多久没人理算"忽略"
export const SPEAK_COOLDOWN_SECONDS = 6;          // 非提醒类的说话冷却时间，避免唠叨
export const CALM_IDLE_MULTIPLIER = 1.6;          // 活跃度"安静"：发呆时间更长
export const LIVELY_IDLE_MULTIPLIER = .6;         // 活跃度"活泼"：发呆时间更短
