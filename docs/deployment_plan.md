# Chapter 4 Deployment Plan (AWS Native)

This deployment plan outlines a 100% AWS-native architecture, utilizing industry-standard managed services to fulfill all syllabus requirements (Load Balancers, API Gateway, Distributed Systems).

## 1. Entry Point: AWS API Gateway
* **Concept:** Distributed Web-Based Systems
* **Implementation:** Acts as the single entry point (Reverse Proxy). Routes all frontend requests (e.g., `/incidents`, `/dispatch`) to the appropriate backend microservice.

## 2. Microservices & Load Balancing: AWS ECS & ALB
* **Concept:** Container Orchestration & Distributed Systems
* **Implementation:** Docker containers are deployed to **AWS Elastic Container Service (ECS)** using Fargate (serverless compute). An **AWS Application Load Balancer (ALB)** sits in front of the ECS cluster to distribute incoming traffic evenly across running container instances and handle health checks.

## 3. Serverless Architecture (FaaS): AWS Lambda
* **Concept:** Serverless Architectures (AWS Case Study)
* **Implementation:** A specific, decoupled background task (e.g., "Dispatch Audit Logger") is deployed as an **AWS Lambda** function. It is triggered asynchronously via MQTT or API Gateway, scaling instantly to handle demand without provisioning servers.

## 4. Distributed File System: Amazon S3
* **Concept:** Distributed File Systems
* **Implementation:** Incident photos uploaded by users are stored directly in **Amazon S3**. S3 acts as a distributed object store, automatically replicating data across multiple Availability Zones for high durability.

## 5. Distributed Database: Amazon DocumentDB
* **Concept:** Modern Distributed Databases
* **Implementation:** Instead of local containers, the database is migrated to **Amazon DocumentDB** (MongoDB compatible). It natively handles replica sets (Primary/Secondary nodes) across different AWS zones to ensure high availability and strong consistency.

## 6. Frontend CDN: S3 + AWS CloudFront
* **Concept:** Content Delivery Networks (CDN)
* **Implementation:** The React frontend is compiled and hosted in an S3 bucket, distributed globally via **AWS CloudFront** edge servers for low-latency access.

---

### End-to-End Request Flow
1. User loads the React app via **AWS CloudFront**.
2. App sends API requests to **AWS API Gateway**.
3. Gateway routes traffic to the **AWS ALB** (Load Balancer).
4. ALB forwards requests to the correct Docker container running in **AWS ECS**.
5. Microservices interact with **Amazon DocumentDB** (Data) and **Amazon S3** (Files).
6. Specific events trigger **AWS Lambda** functions.
