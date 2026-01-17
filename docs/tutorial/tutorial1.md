# 教程一：环境搭建 🛠️

> 从零开始搭建开发环境，迈出第一步。

## 📋 前置要求

开始本教程前，请确保你已经：

- ✅ 了解基本的命令行操作
- ✅ 安装了 Git 版本控制工具
- ✅ 拥有 GitHub 账号

## 🚀 步骤一：安装 Node.js

Node.js 是运行 JavaScript 的环境。

```bash
# 检查是否已安装
node -v

# macOS (使用 Homebrew)
brew install node

# Windows (使用 winget)
winget install OpenJS.NodeJS.LTS

# Linux (使用 apt)
sudo apt update
sudo apt install nodejs npm
```

## 📦 步骤二：安装 Docsify CLI

```bash
# 全局安装 docsify-cli
npm install -g docsify-cli

# 验证安装
docsify -v
```

## 📁 步骤三：初始化项目

```bash
# 创建项目目录
mkdir my-docs && cd my-docs

# 初始化 docsify
docsify init ./docs

# 启动本地服务
docsify serve docs
```

## ✨ 验证结果

启动成功后，打开浏览器访问：

```
http://localhost:3000
```

你应该能看到默认的文档页面。

## 🎯 下一步

环境搭建完成！接下来学习 [教程二：内容编写](tutorial/tutorial2.md)。

---

> 💡 遇到问题？查看 [常见问题](about.md) 或提交 Issue。
