// 发布版本不显示控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    meiqiu_water_pet_lib::run()
}
