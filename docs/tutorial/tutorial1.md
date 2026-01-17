# 环境搭建

从零开始搭建开发环境。

## 前置要求

- 了解基本命令行操作
- 安装 Git
- 拥有 GitHub 账号

## 安装 Node.js

```bash
# 检查是否已安装
node -v

# macOS
brew install node

# Windows
winget install OpenJS.NodeJS.LTS
```

## 安装 Docsify CLI

```bash
npm install -g docsify-cli
docsify -v
```

## 初始化项目

```bash
mkdir my-docs && cd my-docs
docsify init ./docs
docsify serve docs
```

## 下一步

继续学习 [内容编写](tutorial/tutorial2.md)。
