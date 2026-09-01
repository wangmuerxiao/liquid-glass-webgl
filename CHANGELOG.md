# Changelog | 更新日志

This file records notable user-facing changes to Liquid Glass WebGL.

本文件记录 Liquid Glass WebGL 面向用户的重要改动。

## 2026-09-02

### Magnifier interaction upgrade | 放大镜交互升级

- Added spring-based liquid deformation to the magnifier. Dragging and releasing now produces inertia, compression, stretch and elastic recovery instead of moving like a rigid glass sphere.
- 为放大镜加入基于弹簧的液态形变；拖动和释放时会呈现惯性、压缩、拉伸与弹性回弹，不再像刚性玻璃球一样移动。
- Improved edge rendering and expanded the shadow padding to remove the faint rectangular dark artifact around the lens.
- 改进边缘渲染并扩大阴影留白，消除透镜周围微弱的方形黑影。
- Reworked text hit testing with line-aware targeting and cross-line hysteresis, keeping the caret vertically centered and reducing accidental jumps to adjacent lines.
- 重做文字命中算法，加入行区域判断与跨行迟滞，使光标位置更居中，并减少点击行边缘时误触相邻行的问题。
- Added spring animation between caret positions, including smoother same-line movement and visibly continuous transitions across lines.
- 为字间光标移动加入弹簧过渡，同一行移动更顺滑，跨行时也保持连续动画，不再直接闪现。
- Made the demonstration text fully editable with keyboard input, IME composition, selection, paste, undo and automatic scrolling for long content.
- 演示文字现可自由编辑，并支持键盘输入、中文输入法、选区、粘贴、撤销以及长文本自动滚动。
- Enlarged the editable text area and made its layout responsive so the demo uses more of the available screen.
- 放大可编辑文字区域并加入响应式布局，使演示内容更充分地利用屏幕空间。

