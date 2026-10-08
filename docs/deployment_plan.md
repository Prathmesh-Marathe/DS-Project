# Chapter 4 Deployment Plan (AWS EKS / Kubernetes)

This deployment plan outlines a 100% AWS-native architecture, utilizing **Kubernetes (Amazon EKS)** to fulfill the syllabus requirements for Distributed Web-Based Systems and Container Orchestration.

## 1. Container Orchestration: Amazon EKS (Kubernetes)
* **Concept:** Kubernetes Case Study / Distributed Web-Based Systems
* **Implementation:** Instead of running Docker containers locally, we deploy them to **Amazon EKS (Elastic Kubernetes Service)**. Kubernetes manages the containers (Pods), handles auto-scaling, and ensures high availability by restarting any service that crashes.

## 2. Load Balancing & Routing: Kubernetes Ingress & AWS ALB
* **Concept:** API Gateways and Load Balancing
* **Implementation:** We use a **Kubernetes Ingress Controller** hooked up to an **AWS Application Load Balancer (ALB)**. The Ingress acts as the API Gateway—it receives all frontend traffic and intelligently routes requests (e.g., `/incidents` to the Incident Pods, `/dispatch` to the Dispatch Pods) while load balancing across multiple container replicas.

## 3. Serverless Architecture (FaaS): AWS Lambda
* **Concept:** Serverless Architectures (AWS Case Study)
* **Implementation:** A decoupled background task (e.g., "Dispatch Audit Logger") is deployed as an **AWS Lambda** function. It is triggered asynchronously, scaling instantly to handle demand without provisioning servers.

## 4. Distributed File System: Amazon S3
* **Concept:** Distributed File Systems
* **Implementation:** Incident photos uploaded by users are stored directly in **Amazon S3**. S3 acts as a distributed object store, automatically replicating data across multiple Availability Zones for high durability.

## 5. Distributed Database: Amazon DocumentDB (or MongoDB Atlas)
* **Concept:** Modern Distributed Databases
* **Implementation:** The database is migrated to **Amazon DocumentDB** (MongoDB compatible). It natively handles replica sets (Primary/Secondary nodes) across different AWS zones to ensure high availability and strong consistency, separating state from our Kubernetes cluster.

## 6. Frontend CDN: S3 + AWS CloudFront
* **Concept:** Content Delivery Networks (CDN) / Cloudflare Case Study
* **Implementation:** The React frontend is compiled and hosted in an S3 bucket, distributed globally via **AWS CloudFront** edge servers for low-latency access.

---

### End-to-End Request Flow
1. User loads the React app via **AWS CloudFront**.
2. App sends API requests to the **AWS ALB (Load Balancer)**.
3. The Load Balancer forwards traffic to the **Kubernetes Ingress** inside EKS.
4. Ingress routes the request to the correct **Kubernetes Pod** (Microservice).
5. Microservices interact with **Amazon DocumentDB** (Data) and **Amazon S3** (Files).
6. Specific events trigger **AWS Lambda** functions.
