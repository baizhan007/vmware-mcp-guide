#!/bin/sh
# 文档2 完整实验复跑：建表 + 三种导入 + 导出
H=/home/hadoop
export JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk
export HADOOP_HOME=$H/hadoop
export HIVE_HOME=$H/apache-hive-3.1.3-bin
export PATH=$PATH:$JAVA_HOME/bin:$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$HIVE_HOME/bin

FILTER='^(SLF4J|log4j|WARN|which:|Logging initialized|Hive Session ID)'
run_hive() { su - hadoop -c "hive -e \"$1\"" 2>&1 | grep -vE "$FILTER"; }

echo "########## 0. 准备数据 ##########"
cat > /home/hadoop/student_data.txt <<'EOF'
1,张三,20,男
2,李四,21,女
3,王五,22,男
4,赵六,20,女
5,孙七,23,男
EOF
chown hadoop:hadoop /home/hadoop/student_data.txt

echo "########## 1. 建外部表 student_external ##########"
su - hadoop -c "hdfs dfs -mkdir -p /user/hive/warehouse/student_external"
su - hadoop -c "hdfs dfs -put -f /home/hadoop/student_data.txt /user/hive/warehouse/student_external/"
run_hive "drop table if exists student_external;
create external table student_external(id int,name string,age int,gender string)
row format delimited fields terminated by ','
location '/user/hive/warehouse/student_external';
select * from student_external;"

echo "########## 2. 建内部表 student2 ##########"
run_hive "drop table if exists student2;
create table student2(id int,name string,age int,gender string)
row format delimited fields terminated by ',';
describe student2;"

echo "########## 3. 方式A: load data local inpath ##########"
cp /home/hadoop/student_data.txt /home/hadoop/student_local.txt
chown hadoop:hadoop /home/hadoop/student_local.txt
run_hive "load data local inpath '/home/hadoop/student_local.txt' into table student2;
select * from student2;"
echo "-- 本地源文件是否还在 --"
ls -l /home/hadoop/student_local.txt

echo "########## 4. 方式B: load data inpath ##########"
su - hadoop -c "hdfs dfs -mkdir -p /user/hadoop/import"
su - hadoop -c "hdfs dfs -put -f /home/hadoop/student_data.txt /user/hadoop/import/student_hdfs.txt"
echo "-- 导入前 --"
su - hadoop -c "hdfs dfs -ls /user/hadoop/import/"
run_hive "load data inpath '/user/hadoop/import/student_hdfs.txt' into table student2;"
echo "-- 导入后（应为空）--"
su - hadoop -c "hdfs dfs -ls /user/hadoop/import/ 2>&1 || echo '(目录已空)'"

echo "########## 5. 方式C: insert into select ##########"
run_hive "insert into table student2 select * from student_external;"
run_hive "select count(*) as cnt from student2;"

echo "########## 6. 方式D: 导出到本地 ##########"
rm -rf /home/hadoop/hive_out
mkdir -p /home/hadoop/hive_out
chown -R hadoop:hadoop /home/hadoop/hive_out
run_hive "insert overwrite local directory '/home/hadoop/hive_out'
row format delimited fields terminated by '\t'
select * from student2;"
ls -l /home/hadoop/hive_out/
echo "-- 导出内容（前5行）--"
head -5 /home/hadoop/hive_out/000000_0

echo "########## 7. YARN 任务列表 ##########"
su - hadoop -c "yarn application -list -appStates ALL" 2>&1 | tail -8

echo "########## DONE ##########"
