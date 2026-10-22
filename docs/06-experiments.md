# 第六章 做实验：把命令封装成脚本

[← 上一章：注册 MCP](05-register.md) | [返回目录](../README.md) | [下一章：出报告 →](07-reports.md)

---

## 6.1 为什么不用 MCP 直接跑长命令

MCP 单次调用有超时（默认 120 秒），而且用 `;` 串联多条命令**只返回最后一条输出**。

装包、跑 MR 任务动辄几分钟，直接调 MCP 会超时中断。

```powershell
# 反例：3 分钟的命令，120 秒后超时
run_command_in_guest {
  command: "yum install -y java && start-dfs.sh && sleep 60 && jps"
}
→ 超时，不知道进行到哪一步
```

**正确做法：写本地 `.sh` 脚本，通过 SSH 一次性送进去执行。**

## 6.2 实验脚本的写法

### 基本结构

```bash
#!/bin/sh
# 每次都用 set -e 让错误立即暴露（可选）
set -e

# ① 环境变量必须显式导出
export JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk
export HADOOP_HOME=/home/hadoop/hadoop
export HIVE_HOME=/home/hadoop/apache-hive-3.1.3-bin
export PATH=$PATH:$JAVA_HOME/bin:$HADOOP_HOME/bin:$HIVE_HOME/bin

# ② 封装重复调用
FILTER='^(SLF4J|log4j|WARN|which:|Logging initialized|Hive Session ID)'
run_hive() {
  su - hadoop -c "hive -e \"$1\"" 2>&1 | grep -vE "$FILTER"
}

# ③ 分步执行，每步都有输出
echo "########## 1. 建表 ##########"
run_hive "create table if not exists t1(id int);"

echo "########## 2. 导入数据 ##########"
run_hive "load data local inpath '/tmp/data.txt' into table t1;"

echo "########## 3. 验证 ##########"
run_hive "select count(*) from t1;"
```

### 为什么环境变量必须显式导出

`su - hadoop` 会加载 `~/.bash_profile`，但 **SSH 非交互式 shell 不会**。
所以脚本里必须自己 export，否则 `hive: command not found`。

### 为什么用 `grep -vE` 过滤

Hive 启动会打一堆 SLF4J 警告，把真实输出淹没了。过滤掉才能看清结果。

## 6.3 lab.ps1：日常操作总入口

把高频操作封装成子命令，避免每次重写：

```powershell
cd D:\path\to\lab

.\lab.ps1 status              # 环境全景
.\lab.ps1 start               # 一键启动所有服务
.\lab.ps1 stop                # 停止
.\lab.ps1 shot yarn           # 截 YARN 页面
.\lab.ps1 hive "show databases;"
.\lab.ps1 sql "select * from hive_metastore.TBLS;"
.\lab.ps1 run experiments\xxx.sh
```

### `start` 的关键设计：先判断再启动

```bash
if su - hadoop -c "jps" 2>/dev/null | grep -q NameNode; then
  echo "NameNode 已在运行，跳过"
else
  su - hadoop -c "start-dfs.sh"
fi
```

这样**反复执行 start 也不会重复启动或报错**。这是幂等性设计。

### `status` 的输出示例

```
=== 虚拟机 ===
  [OK] centos 运行中，IP 192.168.7.128
=== 进程 ===
  3729 DataNode
  17202 JobHistoryServer
  3923 SecondaryNameNode
  3557 NameNode
  4296 NodeManager
  4173 ResourceManager
=== 服务 ===
  mariadb=active
=== 版本 ===
  openjdk version "1.8.0_412"
  Hadoop 3.3.6
  mysql=5.5.68-MariaDB
=== 元数据库 ===
  hive_metastore 表数: 74
  已登记 Hive 表: student2, student_external
=== 隧道 ===
  [OK] 运行中 (pid 34432)
```

一眼看清环境状态，比敲十条命令强。

完整实现见 [`examples/lab.ps1`](../examples/lab.ps1)。

## 6.4 一次典型实验的完整流程

以「Hive 元数据切换 + 四种导入方式」为例。

### ① 动手前先打快照

装环境失败可回滚。**这一步不能省**。

```
AI: 调用 take_snapshot {"vm":"centos","name":"before-hadoop"}
```

### ② 装底座（写脚本，后台跑）

```bash
yum install -y java-1.8.0-openjdk java-1.8.0-openjdk-devel

# 下载 Hadoop/Hive（放后台，避免超时）
nohup ./dl.sh > dl.log 2>&1 &

# 稍后查进度
cat dl.log
ls -l software/
```

### ③ 按文档逐条执行，边跑边验证

```bash
schematool -dbType mysql -initSchema
# 验证：mysql 里应该有 74 张表
mysql -uroot -p123456 -e "use hive_metastore; show tables;" | wc -l
```

### ④ 记录真实输出（不要编）

```text
Starting Job = job_1792674462988_0004
Stage-Stage-1: Map: 1  Reduce: 1  Cumulative CPU: 3.95 sec  SUCCESS
Time taken: 54.21 seconds
```

> 报告里的每个数字都应该来自真实输出。编造的数值经不起验收提问。

### ⑤ 截 Web UI

```powershell
.\lab.ps1 shot yarn
.\lab.ps1 shot history
.\lab.ps1 shot hdfs
```

### ⑥ 生成报告

```powershell
python lab\report_builder.py --out 报告.docx --config 配置.json
```

## 6.5 处理耗时的下载

国内下载 Hadoop/Hive 会遇到镜像失效问题。实测可用源：

| 软件 | 源 | 实测速度 |
|:---|:---|:---:|
| Hadoop 3.3.6 | `mirrors.cloud.tencent.com` | 3.4 MB/s |
| Hive 3.1.3 | `repo.huaweicloud.com` | 1.9 MB/s |
| MySQL 驱动 | `maven.aliyun.com` | 快 |

**已失效的源**（2026-10 实测）：阿里云、腾讯云、清华 TUNA、中科大、北外、南大，
Hive 3.1.3 全部 404 或 403。`archive.apache.org` 只有 50 KB/s（326 MB 要两小时）。

### 下载脚本模板

```bash
#!/bin/sh
cd /home/hadoop/software

HADOOP_URL=https://mirrors.cloud.tencent.com/apache/hadoop/common/hadoop-3.3.6/hadoop-3.3.6.tar.gz
HIVE_URL=https://repo.huaweicloud.com/apache/hive/hive-3.1.3/apache-hive-3.1.3-bin.tar.gz
JAR_URL=https://maven.aliyun.com/repository/public/mysql/mysql-connector-java/8.0.30/mysql-connector-java-8.0.30.jar

echo "[$(date +%T)] start"
curl -sSL -o hadoop-3.3.6.tar.gz "$HADOOP_URL" && echo "[$(date +%T)] hadoop ok"
curl -sSL -o apache-hive-3.1.3-bin.tar.gz "$HIVE_URL" && echo "[$(date +%T)] hive ok"
curl -sSL -o mysql-connector-java-8.0.30.jar "$JAR_URL" && echo "[$(date +%T)] jar ok"
echo "[$(date +%T)] DONE"
```

用 `nohup` 后台跑，定期 `cat dl.log` 查进度。

---

[← 上一章：注册 MCP](05-register.md) | [返回首页](../README.md) | [下一章：出报告 →](07-reports.md)
