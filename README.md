# Keywords Highlighter

屏幕关键字高亮应用 - 自动识别并标记屏幕上的关键字（如"LLM"）

## 功能特性

- 🔍 自动识别屏幕上的 "LLM" 关键字
- 🎨 使用红色下划线标记关键字位置
- ⚡ 屏幕稳定 200ms 后自动扫描
- 🪟 透明 overlay 窗口，不影响正常操作
- 🖥️ 使用 macOS Vision API 进行 OCR 识别

## 系统要求

- macOS 10.15 或更高版本
- Node.js 18+ 
- Xcode Command Line Tools

## 安装

```bash
# 安装依赖
npm install

# 编译 TypeScript 和原生模块
npm run build
```

## 使用方法

### 1. 启动应用

```bash
npm start
```

### 2. 授予屏幕录制权限

首次运行时，macOS 会提示需要屏幕录制权限：

1. 打开 **系统设置** > **隐私与安全性** > **屏幕录制**
2. 找到 **Electron** 或 **keywords-highlighter**
3. 勾选启用权限
4. 重启应用

### 3. 测试功能

1. 打开任意应用（如终端、浏览器、文本编辑器）
2. 输入或显示 "LLM" 文字
3. 等待 200ms，应用会自动识别并在文字下方绘制红色下划线
4. 当屏幕内容变化时，下划线会自动清除并重新识别

## 工作原理

```
屏幕捕获 (500ms 间隔)
    ↓
变化检测 (图像哈希对比)
    ↓
200ms 防抖等待
    ↓
OCR 识别 (macOS Vision API)
    ↓
关键字匹配 ("LLM")
    ↓
绘制下划线 (透明 overlay)
```

## 项目结构

```
keywords-highlighter/
├── src/
│   ├── main/
│   │   ├── index.ts              # 主进程入口
│   │   ├── screenCapture.ts      # 屏幕捕获和变化检测
│   │   ├── ocrManager.ts         # OCR 协调和关键字匹配
│   │   └── overlayManager.ts     # Overlay 窗口管理
│   ├── renderer/
│   │   ├── overlay.html          # Overlay HTML
│   │   ├── overlay.ts            # Canvas 绘制逻辑
│   │   └── overlay.css           # 透明样式
│   ├── preload/
│   │   └── preload.ts            # IPC 桥接
│   └── native/
│       ├── ocr_bridge.mm         # Swift OCR 原生模块
│       └── binding.gyp           # 原生模块构建配置
├── dist/                         # 编译输出
├── build/Release/ocr.node        # 原生 OCR 模块
└── package.json
```

## 开发

```bash
# 开发模式（自动重新编译）
npm run dev

# 仅编译 TypeScript
npx tsc

# 仅编译原生模块
npx node-gyp rebuild

# 打包应用
npm run package
```

## 故障排除

### "No screen sources available"

- 确保已授予屏幕录制权限
- 重启应用使权限生效

### 原生模块编译失败

```bash
# 确保使用系统 libtool（避免 Anaconda 冲突）
PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH" npx node-gyp rebuild
```

### Electron 下载失败

```bash
# 使用国内镜像
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install electron
```

## 技术栈

- **Electron 33.x** - 跨平台桌面应用框架
- **TypeScript** - 类型安全开发
- **macOS Vision API** - 原生 OCR 能力
- **Sharp** - 图像处理和变化检测
- **Node.js N-API** - 原生模块桥接

## MVP 限制

当前版本为 MVP，仅实现核心功能：

- ✅ 硬编码关键字 "LLM"
- ✅ 仅支持主显示器
- ✅ 固定红色下划线样式
- ❌ 不支持配置关键字列表
- ❌ 不支持多显示器
- ❌ 不支持自定义样式

## 未来增强

- 可配置关键字列表
- 多显示器支持
- 自定义高亮颜色和样式
- 设置界面
- 快捷键开关
- 性能优化模式

## 许可证

MIT
