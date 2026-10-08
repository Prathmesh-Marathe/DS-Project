# AWS Deployment Status Tracker

This document tracks our progress in deploying the DERRCS application to AWS. 

### Phase 1: Prerequisites & External Services
- [x] **Step 1:** Set up AWS Account, AWS CLI, and IAM User.
- [x] **Step 2:** Set up MongoDB Atlas (Distributed Database).
- [x] **Step 3:** Create Amazon S3 Bucket (Distributed File System).

### Phase 2: Containerizing & Registry
- [x] **Step 4:** Create AWS ECR (Elastic Container Registry) repositories.
- [x] **Step 5:** Build and push Docker images for all backend microservices to ECR.

### Phase 3: Amazon EKS (Kubernetes)
- [x] **Step 6:** Spin up an Amazon EKS Cluster. *(Created `derrcs-cluster` in `ap-south-1` with two ready `t3.small` worker nodes.)*
- [x] **Step 7:** Write Kubernetes YAML manifests (Deployments & Services).
- [x] **Step 8:** Deploy Microservices to EKS. *(Backend pods are running in namespace `derrcs`; stateless services scaled to 2 replicas for Kubernetes load balancing, broker kept at 1 replica.)*
- [ ] **Step 9:** Configure Kubernetes Ingress (AWS ALB) for routing.

### Phase 4: Serverless
- [x] **Step 10:** Create and deploy the AWS Lambda function.

### Phase 5: Frontend
- [ ] **Step 11:** Build React frontend for production.
- [ ] **Step 12:** Upload frontend to S3 and configure CloudFront CDN.

---
**Current Status:** Backend microservices are deployed and healthy on EKS. Next: configure proper ALB/Ingress routing and update the frontend API base URL before S3/CloudFront deployment.
