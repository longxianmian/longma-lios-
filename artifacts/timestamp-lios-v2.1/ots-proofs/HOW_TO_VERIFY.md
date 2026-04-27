# OpenTimestamps 时间戳验证指引

## 简介

本目录包含 LIOS v2.1 核心资产的 OpenTimestamps 时间戳证明文件（.ots）。
每个 .ots 文件都对应一份原始资产，证明该资产在特定时间点已存在且未被篡改。

时间戳锚定方式：通过 OpenTimestamps 网络提交至 Bitcoin 区块链，
由比特币区块链作为不可篡改的全球公共时间源。

## 文件清单

| .ots 证明文件 | 对应原始资产 | 资产位置 |
|---|---|---|
| LIOS_v2.1_时间戳认证包_20260427.zip.ots | 完整认证包（含全部代码与文档摘要） | artifacts/ |
| lios_governance_engineering_whitepaper_v2_1.md.ots | 治理工程化白皮书 v2.1 | docs/ |
| two_physical_laws.md.ots | 两律宪法 | docs/ |
| LIOS_时间戳与权属临时声明.md.ots | 权属临时声明 | docs/legal/ |
| r3_failure_analysis.md.ots | R3 失败诊断报告 | docs/ |

## 验证方法

### 方法 1：使用 ots 命令行工具

安装：
```bash
pip3 install opentimestamps-client
# 或
brew install opentimestamps
```

验证：
```bash
# 把原始文件和 .ots 文件放在同一目录
ots verify <原始文件>.ots
```

输出含义：
- "Success! Bitcoin block N attests existence as of YYYY-MM-DD HH:MM:SS UTC" → 验证通过
- "Pending confirmation in Bitcoin blockchain" → 已提交，等待比特币确认（3-24 小时内）
- "Bad timestamp" → 文件被篡改或证明无效

### 方法 2：在线验证（无需安装工具）

访问：https://opentimestamps.org/
拖入 .ots 文件 + 原始文件即可验证。

## 法律含义

OpenTimestamps 时间戳证明的是：
- **存在性**：某文件在某个比特币区块产出之前已经存在
- **完整性**：该文件内容自时间戳生成后未被任何修改

不证明：
- **作者身份**（需配合署名声明 + 创作过程证据）
- **法律意义上的权属**（需配合著作权登记或时间戳公证）

本时间戳作为 LIOS v2.1 阶段性内部测试存证，
正式法律保护以后续与持牌时间戳服务商或版权登记机构的认证为准。

## 联系

著作权所有人：龙先冕
商业化承接主体：龙码（广州）数字科技有限公司
